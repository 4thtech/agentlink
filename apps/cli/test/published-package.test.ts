// OPS-REL-1: the package that npm publishes, as users get it (owner decision 2026-10-16: for
// v0.1.0 only the CLI publishes, as `@4thtech/agentlink`, with the @agentlink/* workspace packages
// bundled into one file; they stay private).
//
// Checks the manifest, the bundle `dist/agentlink.js` (built by `pnpm build`), the exact file list
// of `npm pack`, and that the bundle runs with nothing but the declared `dependencies`: `--version`,
// `--help`, `doctor` in an empty home, and an MCP `initialize` + `tools/list` handshake whose tools
// equal the committed tool-surface snapshot (M1-9e). The module-graph guard (D-76) runs against the
// bundle too, in test/mcp-module-graph.test.ts.
//
// Needs the build: CI runs `pnpm build` before `pnpm test`. Locally: `pnpm build` first.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const packageDir = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const bundlePath = join(packageDir, 'dist', 'agentlink.js');
const SNAPSHOT = new URL('./fixtures/tool-surface.json', import.meta.url);

interface Manifest {
  name: string;
  version: string;
  private?: boolean;
  license?: string;
  type?: string;
  bin?: Record<string, string>;
  files?: string[];
  main?: string;
  exports?: unknown;
  engines?: Record<string, string>;
  repository?: { type?: string; url?: string; directory?: string };
  publishConfig?: Record<string, unknown>;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as Manifest;
const rootManifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as Manifest;

/** The files `npm pack` puts into the tarball: exactly these, nothing else. */
const PACKED_FILES = ['LICENSE', 'README.md', 'dist/agentlink.js', 'package.json'];

/** An exact version: no range, tag, protocol or URL. */
const EXACT = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

function readBundle(): string {
  if (!existsSync(bundlePath)) {
    throw new Error(
      'dist/agentlink.js is missing: run `pnpm build` first (CI builds before tests).',
    );
  }
  return readFileSync(bundlePath, 'utf8');
}

/** The package name of a bare import specifier (`@scope/name/sub` -> `@scope/name`). */
function packageName(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]!;
}

/** Every module specifier the bundle imports (static `import … from`, bare `import`, `import()`). */
function importSpecifiers(code: string): string[] {
  const found = new Set<string>();
  for (const pattern of [
    /^\s*import\s[^;]*?\sfrom\s*["']([^"']+)["']/gm,
    /^\s*import\s*["']([^"']+)["']/gm,
    /^\s*export\s[^;]*?\sfrom\s*["']([^"']+)["']/gm,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  ]) {
    for (const match of code.matchAll(pattern)) found.add(match[1]!);
  }
  return [...found].sort();
}

const home = mkdtempSync(join(tmpdir(), 'agentlink-published-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));

/** The environment of a user's shell: an empty home, no inherited AgentLink or Node settings. */
const userEnv = (): NodeJS.ProcessEnv => ({
  PATH: process.env['PATH'] ?? '',
  HOME: home,
  USERPROFILE: home,
});

function runBundle(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [bundlePath, ...args], {
    cwd: home,
    env: userEnv(),
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('the published manifest (@4thtech/agentlink)', () => {
  it('is the public CLI package', () => {
    expect(manifest.name).toBe('@4thtech/agentlink');
    expect(manifest.private).toBeUndefined();
    expect(manifest.license).toBe('MIT');
    expect(manifest.type).toBe('module');
    expect(manifest.bin).toEqual({ agentlink: './dist/agentlink.js' });
    expect(manifest.engines).toEqual({ node: rootManifest.engines?.['node'] });
    expect(manifest.repository).toEqual({
      type: 'git',
      url: 'git+https://github.com/4thtech/agentlink.git',
      directory: 'apps/cli',
    });
  });

  it('publishes publicly with provenance, to the default registry and the plan dist-tag only', () => {
    expect(manifest.publishConfig).toEqual({ access: 'public', provenance: true });
  });

  it('lists exactly the bundle in `files` and exports no library entry', () => {
    expect(manifest.files).toEqual(['dist/agentlink.js']);
    expect(manifest.main).toBeUndefined();
    expect(manifest.exports).toBeUndefined();
  });

  it('has no lifecycle script that runs on install, pack or publish', () => {
    const scripts = Object.keys(manifest.scripts ?? {});
    const lifecycle = scripts.filter((name) =>
      /^(pre|post)?(install|prepare|pack|publish|prepublishOnly|version)$/.test(name),
    );
    expect(lifecycle).toEqual([]);
  });

  it('declares no workspace package at runtime: they are bundled', () => {
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies'] as const) {
      for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
        expect(name.startsWith('@agentlink/'), `${field}.${name}`).toBe(false);
        expect(spec.startsWith('workspace:'), `${field}.${name}`).toBe(false);
      }
    }
    expect(manifest.peerDependencies).toBeUndefined();
    expect(manifest.optionalDependencies).toBeUndefined();
  });

  it('pins every runtime dependency to an exact version', () => {
    for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
      expect(spec, name).toMatch(EXACT);
    }
  });
});

describe('the bundle (dist/agentlink.js)', () => {
  it('is an executable ES module with a node shebang', () => {
    expect(readBundle().split('\n', 1)[0]).toBe('#!/usr/bin/env node');
  });

  it('bundles every workspace package and imports only Node built-ins and the declared dependencies', () => {
    const specifiers = importSpecifiers(readBundle());
    const bare = specifiers.filter((s) => !s.startsWith('node:'));
    expect(specifiers.filter((s) => s.startsWith('.') || s.startsWith('/'))).toEqual([]);
    expect(bare.filter((s) => s.startsWith('@agentlink/'))).toEqual([]);
    const imported = [...new Set(bare.map(packageName))].sort();
    expect(imported).toEqual(Object.keys(manifest.dependencies ?? {}).sort());
  });

  it('carries no source map, no build-machine path and no test seam', () => {
    const code = readBundle();
    expect(code).not.toMatch(/sourceMappingURL/);
    expect(code).not.toContain(repoRoot);
    expect(code).not.toContain(packageDir);
    expect(code).not.toMatch(/MemoryOwnerKeyStore|MemoryKeyStore|from ["']vitest["']/);
  });
});

describe('npm pack', () => {
  it('packs exactly the allowlisted files', () => {
    readBundle();
    const result = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: packageDir,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      env: { ...process.env, npm_config_loglevel: 'silent' },
    });
    expect(result.status, result.stderr).toBe(0);
    const [packed] = JSON.parse(result.stdout) as [
      { name: string; version: string; files: { path: string }[] },
    ];
    expect(packed.name).toBe('@4thtech/agentlink');
    expect(packed.files.map((file) => file.path).sort()).toEqual(PACKED_FILES);
  });
});

describe('the bundle runs with only the declared dependencies', () => {
  it('prints the package version for --version', () => {
    readBundle();
    const run = runBundle(['--version']);
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe(manifest.version);
  });

  it('prints the usage for --help', () => {
    const run = runBundle(['--help']);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('agentlink');
    expect(run.stdout).toContain('Options: --help, --version');
  });

  it('runs doctor in an empty home: fixed text, no crash', () => {
    const run = runBundle(['doctor']);
    expect(run.stderr).not.toMatch(/ERR_MODULE_NOT_FOUND|Cannot find (package|module)|\n\s+at /);
    expect([0, 1]).toContain(run.status);
    expect(`${run.stdout}${run.stderr}`.trim()).not.toBe('');
  });

  it('answers initialize and tools/list over stdio with the committed tool surface', async () => {
    readBundle();
    const child = spawn(process.execPath, [bundlePath, 'mcp'], {
      cwd: home,
      env: userEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    const send = (message: object): void => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const waitFor = async (id: number): Promise<void> => {
      for (let i = 0; i < 300 && !stdout.includes(`"id":${id}`); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'published-package', version: '0' },
      },
    });
    await waitFor(1);
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    await waitFor(2);
    child.stdin.end();
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
    expect(code).toBe(0);
    const responses = stdout
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as { id?: number; result?: Record<string, unknown> });
    const byId = new Map(responses.map((r) => [r.id, r.result]));
    expect(byId.get(1)?.['serverInfo']).toMatchObject({ version: manifest.version });
    const tools = (byId.get(2)?.['tools'] ?? []) as Record<string, unknown>[];
    const surface = tools.map(
      ({ name, title, description, inputSchema, outputSchema, annotations }) => ({
        name,
        title,
        description,
        inputSchema,
        outputSchema,
        annotations,
      }),
    );
    expect(surface).toEqual(JSON.parse(readFileSync(SNAPSHOT, 'utf8')));
  }, 60_000);
});
