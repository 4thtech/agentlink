// The `agentlink mcp` module-graph guard (IR-M1-9c-1 F02). The MCP SDK's dependency tree carries
// crypto-capable packages outside the AGENTS.md crypto allowlist (jose, pkce-challenge, express's
// cookie-signature and etag, hono's JWT and crypto helpers), all for the SDK's HTTP and OAuth
// transports. None may load on our stdio path. This test runs the real CLI from source in a child
// process (no build), starts `agentlink mcp`, does `initialize`, `tools/list` and a `tools/call`
// over stdio, closes stdin, and checks every module that was loaded (ESM resolve trace plus the
// CommonJS require cache):
//
// - no file of a banned package: every SDK dependency outside STDIO_PACKAGES (read from the SDK's
//   own package.json, so a dependency a new SDK version adds is banned too), plus the crypto-capable
//   transitive packages named above;
// - every SDK file loaded is in SDK_FILES, an explicit allowlist of SDK subpaths. A new SDK version
//   that pulls auth or HTTP code into the stdio path fails here until it is reviewed.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const hooks = new URL('./fixtures/module-trace-hooks.mjs', import.meta.url).href;
const sdkPackage = JSON.parse(
  readFileSync(
    new URL('../node_modules/@modelcontextprotocol/sdk/package.json', import.meta.url),
    'utf8',
  ),
) as { dependencies: Record<string, string> };

/** SDK dependencies the stdio server and the protocol types use. */
const STDIO_PACKAGES = ['ajv', 'ajv-formats', 'zod', 'zod-to-json-schema'];
/** Crypto-capable transitive packages of the SDK's HTTP and OAuth code. */
const CRYPTO_TRANSITIVE = [
  'cookie-signature',
  'etag',
  'jose',
  'pkce-challenge',
  'hono',
  '@hono/node-server',
];
const BANNED = [
  ...Object.keys(sdkPackage.dependencies).filter((name) => !STDIO_PACKAGES.includes(name)),
  ...CRYPTO_TRANSITIVE,
];

/** The SDK files (under dist/esm/) the stdio path may load. */
const SDK_FILES = [
  'experimental/tasks/helpers.js',
  'experimental/tasks/interfaces.js',
  'experimental/tasks/server.js',
  'server/index.js',
  'server/stdio.js',
  'server/zod-compat.js',
  'server/zod-json-schema-compat.js',
  'shared/protocol.js',
  'shared/stdio.js',
  'types.js',
  'validation/ajv-provider.js',
];

const home = mkdtempSync(join(tmpdir(), 'agentlink-mcp-graph-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));

interface RunResult {
  readonly responses: { id?: number; result?: Record<string, unknown> }[];
  readonly loaded: string[];
  readonly code: number | null;
}

function runMcp(): Promise<RunResult> {
  const traceFile = join(home, 'trace.txt');
  const child = spawn(
    process.execPath,
    ['--experimental-transform-types', '--no-warnings', '--experimental-loader', hooks, cli, 'mcp'],
    {
      // An empty home: no agent is set up, so every tool answers needs_setup.
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: home,
        USERPROFILE: home,
        AGENTLINK_MODULE_TRACE: traceFile,
        // Every CommonJS load is reported on stderr: `MODULE <pid>: load "<file>" for module "..."`.
        NODE_DEBUG: 'module',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const send = (message: object): void => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  const waitFor = async (id: number): Promise<void> => {
    for (let i = 0; i < 300 && !stdout.includes(`"id":${id}`); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  return (async () => {
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'graph', version: '0' },
      },
    });
    await waitFor(1);
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    await waitFor(2);
    send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'agentlink_status', arguments: {} },
    });
    await waitFor(3);
    child.stdin.end();
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
    const responses = stdout
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as RunResult['responses'][number]);
    const esm = readFileSync(traceFile, 'utf8')
      .split('\n')
      .filter((line) => line !== '');
    const cjs = [...stderr.matchAll(/^MODULE \d+: load "([^"]+)" for module/gm)].map(
      (m) => pathToFileURL(m[1]!).href,
    );
    const loaded = [...new Set([...esm, ...cjs])];
    return { responses, loaded, code };
  })();
}

/** The package a loaded file belongs to (its last node_modules segment), or undefined. */
function packageOf(url: string): string | undefined {
  const path = decodeURIComponent(url).replace(/\\/g, '/');
  const at = path.lastIndexOf('/node_modules/');
  if (at < 0) return undefined;
  const [first, second] = path.slice(at + '/node_modules/'.length).split('/');
  return first?.startsWith('@') === true ? `${first}/${second}` : first;
}

describe('agentlink mcp loads no SDK HTTP, OAuth or crypto code on the stdio path (IR-M1-9c-1 F02)', () => {
  let run: RunResult;

  it('starts, answers initialize, tools/list and tools/call over stdio, and exits on stdin close', async () => {
    run = await runMcp();
    expect(run.code).toBe(0);
    const byId = new Map(run.responses.map((r) => [r.id, r.result]));
    expect(byId.get(1)).toHaveProperty('instructions');
    expect((byId.get(2)?.['tools'] as unknown[]).length).toBe(9);
    expect(byId.get(3)?.['structuredContent']).toMatchObject({ status: 'needs_setup' });
  }, 60_000);

  it('traced the SDK and the CommonJS loads (the trace works)', () => {
    expect(run.loaded.some((url) => packageOf(url) === '@modelcontextprotocol/sdk')).toBe(true);
    // ajv's own files are CommonJS requires: only the NODE_DEBUG trace sees them.
    expect(run.loaded.some((url) => url.includes('/ajv/dist/compile/'))).toBe(true);
  });

  it('loads no banned package', () => {
    expect(BANNED).toContain('jose');
    expect(BANNED).toContain('express');
    const banned = run.loaded.filter((url) => BANNED.includes(packageOf(url) ?? ''));
    expect(banned).toEqual([]);
  });

  it('loads only allowlisted SDK files', () => {
    const sdk = run.loaded
      .filter((url) => packageOf(url) === '@modelcontextprotocol/sdk')
      .map((url) => decodeURIComponent(url).replace(/\\/g, '/').split('/dist/esm/')[1] ?? url);
    expect(sdk.filter((file) => !SDK_FILES.includes(file))).toEqual([]);
  });
});
