// The neutral-platform bundle check (M1-9c-c, IR-M1-9c-1 F07; D-76, 06 §1). CI runs
// `node apps/cli/scripts/bundle-check.mjs` in its own `bundle-check` job, beside the module-graph
// guard (test/mcp-module-graph.test.ts). This test drives the script as CI does, as a child
// process, against the built bundle and against copies of it with an injected forbidden import, so
// a check that stops failing is caught here.
//
// Needs the build: CI runs `pnpm build` before `pnpm test`. Locally: `pnpm build` first.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const packageDir = fileURLToPath(new URL('..', import.meta.url));
const script = join(packageDir, 'scripts', 'bundle-check.mjs');
const bundlePath = join(packageDir, 'dist', 'agentlink.js');
const work = mkdtempSync(join(tmpdir(), 'agentlink-bundle-check-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

interface Run {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function check(args: readonly string[]): Run {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: packageDir,
    encoding: 'utf8',
    timeout: 120_000,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

let bundle = '';
beforeAll(() => {
  if (!existsSync(bundlePath)) {
    throw new Error(`${bundlePath} is missing: run \`pnpm build\` first (CI builds before tests).`);
  }
  bundle = readFileSync(bundlePath, 'utf8');
});

/** A copy of the published bundle with `line` added after the shebang, checked alone. */
function checkInjected(name: string, line: string): Run {
  const [shebang, ...rest] = bundle.split('\n');
  const file = join(work, `${name}.js`);
  writeFileSync(file, [shebang, line, ...rest].join('\n'));
  return check(['--bundle', file, '--skip-tools']);
}

/** A stand-in for src/tools/index.ts with the given source, bundled for the neutral platform. */
function checkToolsEntry(name: string, source: string): Run {
  const file = join(work, `${name}.ts`);
  writeFileSync(file, source);
  return check(['--tools-entry', file, '--skip-bundle']);
}

describe('bundle-check (M1-9c-c, IR-M1-9c-1 F07)', () => {
  it('passes on the built bundle and on src/tools/ bundled for the neutral platform', () => {
    const run = check([]);
    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('bundle-check: published bundle ok');
    expect(run.stdout).toContain('bundle-check: src/tools/ neutral bundle ok');
  }, 120_000);

  describe('the published bundle (dist/agentlink.js)', () => {
    it('fails on an injected jose import in the stdio path (IR-M1-9c-1 F07)', () => {
      const run = checkInjected('jose-static', 'import { jwtVerify } from "jose";');
      expect(run.code).toBe(1);
      expect(run.stderr).toContain('"jose"');
    });

    it('fails on an injected dynamic import of jose', () => {
      const run = checkInjected('jose-dynamic', 'const lazyJose = () => import("jose");');
      expect(run.code).toBe(1);
      expect(run.stderr).toContain('"jose"');
    });

    it('fails on a re-export from jose', () => {
      const run = checkInjected('jose-reexport', 'export { jwtVerify } from "jose";');
      expect(run.code).toBe(1);
      expect(run.stderr).toContain('"jose"');
    });

    it.each(['pkce-challenge', 'cookie-signature', 'etag', 'hono', '@hono/node-server'])(
      'fails on the crypto-capable SDK transitive package %s',
      (name) => {
        const run = checkInjected(`banned-${name.replace(/\W/g, '-')}`, `import "${name}";`);
        expect(run.code).toBe(1);
        expect(run.stderr).toContain(`"${name}"`);
      },
    );

    it('fails on an SDK dependency the stdio path does not use (express)', () => {
      const run = checkInjected('sdk-dep', 'import express from "express";');
      expect(run.code).toBe(1);
      expect(run.stderr).toContain('"express"');
    });

    it('fails on an SDK subpath outside the stdio allowlist (OAuth router)', () => {
      const run = checkInjected(
        'sdk-auth',
        'import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";',
      );
      expect(run.code).toBe(1);
      expect(run.stderr).toContain('@modelcontextprotocol/sdk/server/auth/router.js');
    });

    it('fails on a package that is not a declared runtime dependency', () => {
      const run = checkInjected('undeclared', 'import leftPad from "left-pad";');
      expect(run.code).toBe(1);
      expect(run.stderr).toContain('"left-pad"');
    });

    it('fails on a workspace package left unbundled', () => {
      const run = checkInjected('workspace', 'import { x } from "@4thtech-io/core";');
      expect(run.code).toBe(1);
      expect(run.stderr).toContain('"@4thtech-io/core"');
    });

    it('fails on a relative import (the bundle is one file)', () => {
      const run = checkInjected('relative', 'import "./chunk-1.js";');
      expect(run.code).toBe(1);
      expect(run.stderr).toContain('"./chunk-1.js"');
    });

    it('fails on a dynamic import or require it cannot read statically', () => {
      const dynamic = checkInjected('non-literal', 'const load = (n) => import(n);');
      expect(dynamic.code).toBe(1);
      expect(dynamic.stderr).toContain('import(');
      const req = checkInjected('require', 'const j = require("jose");');
      expect(req.code).toBe(1);
      expect(req.stderr).toContain('require(');
    });

    // IR-M1-9c-c-1 L1: only the built-ins the bundle uses today pass.
    it.each(['node:module', 'node:vm', 'node:child_process', 'node:worker_threads', 'node:crypto'])(
      'fails on the built-in %s (outside the bundle allowlist)',
      (name) => {
        const run = checkInjected(`builtin-${name.replace(/\W/g, '-')}`, `import "${name}";`);
        expect(run.code).toBe(1);
        expect(run.stderr).toContain(`"${name}"`);
        expect(run.stderr).toContain('built-in outside the bundle allowlist');
      },
    );

    // IR-M1-9c-c-1 L1: require-equivalents that load a module without an import.
    it.each([
      ['createRequire', 'const cr = createRequire; cr(import.meta.url)("jose");', 'createRequire'],
      ['globalThis.require', 'const j = globalThis.require("jose");', 'require'],
      ['module.require', 'const j = module.require("jose");', 'require'],
      ['computed require', 'const j = globalThis["req" + "uire"]("jose");', 'globalThis['],
      ['getBuiltinModule', 'const m = process.getBuiltinModule("module");', 'getBuiltinModule'],
      ['import.meta.resolve', 'const u = import.meta.resolve("jose");', 'import.meta.resolve'],
    ])('fails on loader access: %s', (name, line, needle) => {
      const run = checkInjected(`loader-${name.replace(/\W/g, '-')}`, line);
      expect(run.code).toBe(1);
      expect(run.stderr).toContain('loader access');
      expect(run.stderr).toContain(needle);
    });
  });

  describe('the neutral bundle output (IR-M1-9c-c-1 L2)', () => {
    it.each([
      ['non-literal import()', 'export const load = (n: string) => import(n);\n', 'import('],
      [
        'getBuiltinModule',
        "export const m = (globalThis as any).process.getBuiltinModule('fs');\n",
        'getBuiltinModule',
      ],
      [
        'computed require',
        "export const r = (globalThis as any)['req' + 'uire'];\n",
        'globalThis[',
      ],
    ])(
      'fails on %s in the output chunk',
      (name, source, needle) => {
        const run = checkToolsEntry(`out-${name.replace(/\W/g, '-')}`, source);
        expect(run.code).toBe(1);
        expect(run.stderr).toContain('neutral bundle output');
        expect(run.stderr).toContain(needle);
      },
      60_000,
    );
  });

  describe('src/tools/ bundled for the neutral (Worker) platform (06 §1, IR-M1-9j-1 F04)', () => {
    it.each([
      [
        'node-prefixed',
        "import { readFileSync } from 'node:fs';\nexport const f = readFileSync;\n",
        'node:fs',
      ],
      ['bare-builtin', "import { join } from 'path';\nexport const j = join;\n", '"path"'],
      ['agentlink-node', "export * from '@4thtech-io/node';\n", '@4thtech-io/node'],
      [
        'mcp-sdk',
        "export { Server } from '@modelcontextprotocol/sdk/server/index.js';\n",
        '@modelcontextprotocol/sdk',
      ],
      ['jose', "export * from 'jose';\n", '"jose"'],
    ])(
      'fails on a %s import',
      (name, source, needle) => {
        const run = checkToolsEntry(name, source);
        expect(run.code).toBe(1);
        expect(run.stderr).toContain(needle);
      },
      60_000,
    );
  });
});
