// Regression tests for review IR-M0-10-1 (bypasses F01 to F10). Each bypass that the review found
// is a red case here, in deps-check and, where the form is visible to ESLint, in ESLint too.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkManifest, checkSource, runChecks, specProblem } from './check.mjs';
import { LIBRARIES, ZONES, violationFor } from './policy.mjs';

const ROOT = '/repo';
const src = (zone, code, name = 'src/a.ts') =>
  checkSource(zone, join(ROOT, zone, name), code, ROOT);
const manifest = (zone, extra) => checkManifest(zone, { name: ZONES[zone].name, ...extra });

describe('F01: files in directories that used to be skipped by name', () => {
  const dirs = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function repo(files, { git = true, forceAdd = [] } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'deps-check-f01-'));
    dirs.push(root);
    const all = {
      '.gitignore': 'node_modules/\ndist/\ncoverage/\n.turbo/\n',
      'packages/core/package.json': JSON.stringify({ name: '@agentlink/core' }),
      ...files,
    };
    for (const [path, content] of Object.entries(all)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    if (git) {
      execFileSync('git', ['init', '-q'], { cwd: root });
      for (const path of forceAdd) execFileSync('git', ['add', '-f', path], { cwd: root });
    }
    return root;
  }
  const bad = `/* eslint-disable */\nexport * from 'viem';\n`;

  it.each(['src/.claude/x.ts', 'src/.turbo/x.ts', 'src/coverage/x.ts', 'src/dist/x.ts'])(
    'scans a tracked %s',
    (file) => {
      const path = `packages/core/${file}`;
      const root = repo({ [path]: bad }, { forceAdd: [path] });
      const { problems } = runChecks(root);
      expect(problems.some((problem) => problem.includes(path) && problem.includes('viem'))).toBe(
        true,
      );
      expect(problems.some((problem) => problem.includes('eslint-disable'))).toBe(true);
    },
  );

  it('scans a not-ignored .claude directory even when it is untracked', () => {
    const root = repo({ 'packages/core/src/.claude/x.ts': bad });
    expect(runChecks(root).problems.length).toBeGreaterThan(0);
  });

  it('leaves out ignored, untracked build output, as before', () => {
    const root = repo({ 'packages/core/dist/index.js': bad, 'packages/core/src/index.ts': '' });
    expect(runChecks(root)).toMatchObject({ problems: [], files: 1 });
  });

  it('walks everything but node_modules when there is no repository', () => {
    const root = repo({ 'packages/core/src/dist/x.ts': bad }, { git: false });
    expect(runChecks(root).problems.length).toBeGreaterThan(0);
  });
});

describe('F02: aliases and non-registry specs in manifests', () => {
  it.each([
    ['workspace:@agentlink/node@*', '@agentlink/node'],
    ['workspace:@agentlink/node@^1.0.0', '@agentlink/node'],
  ])('rejects the workspace alias %s under another name', (spec) => {
    for (const field of ['dependencies', 'devDependencies']) {
      const problems = manifest('packages/core', { [field]: { 'keystore-impl': spec } });
      expect(problems.join('\n')).toMatch(/workspace: alias must not point to a different package/);
      expect(problems.join('\n')).toMatch(/may not import @agentlink\/node/);
    }
  });

  it.each([
    'link:../../node_modules/typescript',
    'link:../node',
    'file:../node',
    'file:./evil.tgz',
    'portal:../node',
    'https://example.com/evil.tgz',
    'github:owner/repo',
    'git+https://github.com/owner/repo.git',
    'owner/repo',
    'jsr:@std/path',
    'catalog:default',
    'workspace:../node',
  ])('rejects the spec %s in dependencies and devDependencies', (spec) => {
    expect(specProblem(spec)).not.toBeNull();
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      const problems = manifest('packages/storage', { [field]: { prims: spec } });
      expect(problems.length).toBeGreaterThan(0);
    }
  });

  it.each([
    '^1.2.3',
    '1.x',
    '*',
    'latest',
    '>=1 <2',
    'workspace:*',
    'workspace:^',
    'npm:left-pad@1',
  ])('accepts the spec %s', (spec) => {
    expect(specProblem(spec)).toBeNull();
  });

  it('runs the cycle check on resolved names (a node -> core -> node cycle behind an alias)', () => {
    const root = mkdtempSync(join(tmpdir(), 'deps-check-f02-'));
    const write = (path, content) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), JSON.stringify(content));
    };
    write('packages/node/package.json', {
      name: '@agentlink/node',
      dependencies: { '@agentlink/core': 'workspace:*' },
    });
    write('packages/core/package.json', {
      name: '@agentlink/core',
      devDependencies: { 'keystore-impl': 'workspace:@agentlink/node@*' },
    });
    const { problems } = runChecks(root);
    rmSync(root, { recursive: true, force: true });
    expect(problems.some((problem) => problem.includes('dependency cycle'))).toBe(true);
  });

  it('rejects a package.json imports map (F10)', () => {
    const problems = manifest('packages/core', { imports: { '#x': './src/x.ts' } });
    expect(problems.join('\n')).toMatch(/"imports" map is not allowed/);
  });
});

describe('F03: reaching the module loader around the import checks', () => {
  it.each([
    [`process.getBuiltinModule('crypto').createHash('sha256');`, 'apps/cli'],
    [`process.getBuiltinModule('crypto');`, 'packages/core'],
    [`process['getBuiltinModule']('crypto');`, 'apps/cli'],
    [`const { getBuiltinModule } = process;`, 'apps/cli'],
    [`process.binding('crypto');`, 'apps/cli'],
    [`process.mainModule.require('crypto');`, 'packages/node'],
    [`process.dlopen(m, 'x.node');`, 'packages/node'],
    [`module.require('node:crypto');`, 'apps/cli'],
    [`const r = require; r('node:crypto');`, 'apps/cli'],
    [`require.call(null, 'viem');`, 'packages/core'],
    [`const f = { require }; f.require('x');`, 'packages/core'],
    [
      `import { createRequire } from 'node:module'; createRequire(import.meta.url)('x');`,
      'apps/cli',
    ],
    [`import { createRequire } from 'module';`, 'packages/node'],
    [`import module from 'node:module';`, 'packages/node'],
    [`const m = await import('node:module');`, 'apps/cli'],
  ])('rejects %s in %s', (code, zone) => {
    expect(src(zone, code).length).toBeGreaterThan(0);
  });

  it('still allows a direct literal require of an allowed module, and unrelated names', () => {
    expect(
      src('packages/node', `declare function require(n: string): unknown; require('node:fs');`),
    ).toEqual([]);
    expect(src('packages/core', `const o = { binding: 1 }; o.binding; x.require(1);`)).toEqual([]);
    expect(violationFor('apps/cli', 'node:module', 'apps/cli/src/a.ts')).toMatch(
      /NODE_MODULE_FILES/,
    );
  });
});

describe('F04/F05/F06: other crypto libraries, @hpke, messages', () => {
  it.each([
    'tweetnacl',
    'ethers',
    'elliptic',
    'crypto-js',
    'node-forge',
    'libsodium-wrappers',
    'js-sha3',
    'hash-wasm',
    '@scure/base',
    'ethereum-cryptography',
  ])('forbids %s in every zone, import and manifest', (name) => {
    for (const zone of ['packages/crypto', 'packages/core', 'apps/cli']) {
      expect(violationFor(zone, name, `${zone}/src/a.ts`)).toMatch(/not on the crypto allowlist/);
      expect(manifest(zone, { devDependencies: { [name]: '1.0.0' } }).length).toBeGreaterThan(0);
    }
  });

  it('allows only @hpke/core in packages/crypto (F05)', () => {
    expect(manifest('packages/crypto', { dependencies: { '@hpke/core': '1.0.0' } })).toEqual([]);
    const problems = manifest('packages/crypto', {
      dependencies: { '@hpke/chacha20poly1305': '1.0.0' },
    });
    expect(problems.join('\n')).toMatch(/runtime-dependency allowlist/);
  });

  it('points to the package that wraps each library (F06)', () => {
    const via = Object.fromEntries(LIBRARIES.map((lib) => [lib.group[0], lib.via]));
    expect(via).toMatchObject({
      '@noble/*': '@agentlink/crypto',
      viem: '@agentlink/chain',
      'nostr-tools': '@agentlink/transport-nostr',
      aws4fetch: '@agentlink/storage',
    });
    expect(violationFor('packages/core', 'viem', 'packages/core/src/a.ts')).toMatch(
      /everything else uses @agentlink\/chain/,
    );
  });
});

describe('F07/F08: eval, Reflect and inline config', () => {
  it.each([
    [`eval('1');`],
    [`new Function('return import("viem")');`],
    [`Function('return 1');`],
    [`setTimeout('x', 1);`],
    [`Reflect.get(globalThis.crypto, 'subtle');`],
    [`Object.getOwnPropertyDescriptor(crypto, 'subtle');`],
    [`const k = 's' + 'ubtle'; globalThis.crypto[k];`],
  ])('rejects %s', (code) => {
    expect(src('packages/core', code).length).toBeGreaterThan(0);
  });

  it('keeps Reflect.get and computed access legal inside packages/crypto and on other receivers', () => {
    expect(src('packages/crypto', `Reflect.get(crypto, 'subtle'); crypto[k];`)).toEqual([]);
    expect(src('packages/core', `const a = obj[k]; Reflect.get(obj, 'x');`)).toEqual([]);
  });

  it.each([
    [`/* eslint no-restricted-imports: "off" */`],
    [`/* eslint "boundaries/no-bypass": 0, no-console: 2 */`],
    [`// eslint-disable-next-line no-eval`],
    [`/* eslint-disable no-new-func */`],
  ])('rejects the comment %s', (code) => {
    expect(src('packages/core', code).length).toBeGreaterThan(0);
  });
});
