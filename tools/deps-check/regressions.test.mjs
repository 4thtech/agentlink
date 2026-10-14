// Regression tests for review IR-M0-10-1 (bypasses F01 to F10). Each bypass that the review found
// is a red case here, in deps-check and, where the form is visible to ESLint, in ESLint too.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkManifest, checkSource, runChecks, specProblem } from './check.mjs';
import { LIBRARIES, SUBTLE_EXEMPT_FILES, ZONES, violationFor } from './policy.mjs';

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

describe('test-vectors/: crypto.subtle exemption for the M0-9 placeholder suite only', () => {
  const PLACEHOLDER = 'test-vectors/harness/suites/placeholder-sha256.ts';
  const code = `export const d = crypto.subtle.digest('SHA-256', new Uint8Array());`;
  const inVectors = (path, text = code) =>
    checkSource('test-vectors', join(ROOT, path), text, ROOT);

  it('allows the one exempt file', () => {
    expect(inVectors(PLACEHOLDER)).toEqual([]);
    expect(inVectors(PLACEHOLDER, `Reflect.get(crypto, 'subtle');`)).toEqual([]);
  });

  it.each([
    'test-vectors/harness/suites/other.ts',
    'test-vectors/harness/suites/placeholder-sha256.test.ts',
    'test-vectors/harness/runtime.ts',
    'test-vectors/other/placeholder-sha256.ts',
    'test-vectors/harness/suites/sub/placeholder-sha256.ts',
    'test-vectors/harness/vectors.test.ts',
  ])('still rejects crypto.subtle in %s', (path) => {
    expect(inVectors(path)).toEqual([expect.stringContaining('crypto.subtle')]);
  });

  it.each([
    `const { subtle } = globalThis.crypto;`,
    `globalThis.crypto['subtle'];`,
    `Reflect.get(globalThis.crypto, 'subtle');`,
    `globalThis.crypto[k];`,
  ])('rejects the other forms in a non-exempt file: %s', (text) => {
    expect(inVectors('test-vectors/harness/x.ts', text).length).toBeGreaterThan(0);
  });

  it('does not exempt the same file name in another package', () => {
    expect(src('packages/core', code, 'src/placeholder-sha256.ts')).not.toEqual([]);
  });

  it('checks test-vectors/ for crypto.subtle only (the harness has its own rules)', () => {
    expect(inVectors('test-vectors/harness/x.ts', `import fs from 'node:fs'; fs.x();`)).toEqual([]);
  });

  it('keeps the exemption list short, exact and justified', () => {
    expect(SUBTLE_EXEMPT_FILES.map((entry) => entry.file)).toEqual([PLACEHOLDER]);
    for (const { reason } of SUBTLE_EXEMPT_FILES) expect(reason.trim().length).toBeGreaterThan(20);
  });

  it('runChecks scans test-vectors/ and reports a non-exempt file', () => {
    const root = mkdtempSync(join(tmpdir(), 'deps-check-tv-'));
    const write = (path, text) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    };
    write(PLACEHOLDER, code);
    write('test-vectors/harness/suites/second.ts', code);
    const { problems } = runChecks(root);
    rmSync(root, { recursive: true, force: true });
    expect(problems).toEqual([expect.stringContaining('test-vectors/harness/suites/second.ts:1')]);
  });
});

describe('IR-M0-10-2: symlinks and CommonJS', () => {
  const dirs = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function fixture({ git = true, track = true } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'deps-check-r3-'));
    dirs.push(root);
    const write = (path, text) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    };
    write('packages/core/package.json', JSON.stringify({ name: '@agentlink/core' }));
    write('vendor/lib/x.ts', `export * from 'viem';`);
    write('packages/core/src/leak.ts', `export * from './lib/x.js';`);
    symlinkSync('../../../vendor/lib', join(root, 'packages/core/src/lib'));
    if (git) {
      execFileSync('git', ['init', '-q'], { cwd: root });
      if (track) execFileSync('git', ['add', '-A'], { cwd: root });
    }
    return root;
  }

  it.each([
    ['tracked symlinked directory (mode 120000)', { git: true, track: true }],
    ['untracked symlinked directory', { git: true, track: false }],
    ['symlink found by the full walk (no repository)', { git: false }],
  ])('rejects a %s', (_name, options) => {
    const { problems } = runChecks(fixture(options));
    expect(problems).toEqual([expect.stringContaining('packages/core/src/lib: symbolic links')]);
  });

  it('rejects .cjs files in packages and apps', () => {
    const root = mkdtempSync(join(tmpdir(), 'deps-check-r3-'));
    dirs.push(root);
    mkdirSync(join(root, 'apps/cli/src'), { recursive: true });
    writeFileSync(
      join(root, 'apps/cli/package.json'),
      JSON.stringify({ name: '@4thtech/agentlink' }),
    );
    writeFileSync(join(root, 'apps/cli/src/x.cjs'), `exports.a = 1;`);
    expect(runChecks(root).problems).toEqual([
      expect.stringContaining('apps/cli/src/x.cjs: CommonJS'),
    ]);
  });

  it.each([
    `const m = module; m.require('../../crypto/src/x.js');`,
    `module.constructor._load('viem');`,
    `module.constructor.createRequire(__filename)('@noble/curves');`,
    `module.exports = {};`,
    `export const m = { module };`,
  ])('rejects the CommonJS module object: %s', (code) => {
    for (const zone of ['packages/core', 'apps/cli']) {
      expect(src(zone, code).join('\n')).toMatch(/"module" \(CommonJS\)/);
    }
  });

  it('allows names that are only called module', () => {
    expect(
      src('packages/core', `import module from './module.js'; const o = { module: 1 }; o.module;`),
    ).toEqual([]);
  });
});

describe('IR-M1-1b-1 M-1: the restricted @agentlink/crypto/keystore subpath', () => {
  const keystore = `import { deriveSecretKey } from '@agentlink/crypto/keystore';\n`;

  it('fails when packages/core imports it, in every form', () => {
    for (const code of [
      keystore,
      `export { deriveKey } from '@agentlink/crypto/keystore';\n`,
      `const m = await import('@agentlink/crypto/keystore');\n`,
      `type T = import('@agentlink/crypto/keystore').PublicIdentity;\n`,
    ]) {
      expect(src('packages/core', code).join('\n')).toMatch(
        /@agentlink\/crypto\/keystore may be imported only in packages\/node, test-vectors/,
      );
    }
    expect(
      violationFor('packages/core', '@agentlink/crypto/keystore', 'packages/core/src/a.ts'),
    ).toMatch(/KeyStore interface/);
  });

  // packages/node hosts the KeyStore backends. Whether it may import @agentlink/crypto at all is the
  // package layering (ZONES), which today does not list crypto for it; the card that adds the file
  // and keychain backends widens that. This rule must not be what stops it.
  const RESTRICTED =
    /@agentlink\/crypto\/keystore may be imported only in packages\/node, test-vectors/;
  const ruleFor = (zone) =>
    violationFor(zone, '@agentlink/crypto/keystore', `${zone}/src/a.ts`) ?? '';

  it('applies in every zone except packages/node, even where @agentlink/crypto is allowed', () => {
    const exempt = Object.keys(ZONES).filter((zone) => !RESTRICTED.test(ruleFor(zone)));
    expect(exempt).toEqual(['packages/node']);
    expect(violationFor('packages/core', '@agentlink/crypto', 'packages/core/src/a.ts')).toBeNull();
  });

  it('exempts packages/node (layering still applies) and allows the vector harness', () => {
    expect(ruleFor('packages/node')).not.toMatch(RESTRICTED);
    expect(src('packages/node', keystore).join('\n')).not.toMatch(RESTRICTED);
    // test-vectors has no layering entry (its own ESLint config governs its imports, and pnpm lint
    // passes with the suites importing the subpath); this rule must not name it.
    expect(ruleFor('test-vectors')).not.toMatch(RESTRICTED);
  });
});

describe('IR-M1-1g-1 M-2: the test-only @agentlink/crypto/testing subpath', () => {
  const testing = `import { MemoryKeyStore } from '@agentlink/crypto/testing';\nvoid MemoryKeyStore;\n`;
  const TEST_ONLY = /@agentlink\/crypto\/testing may be imported only in test files/;

  it('is refused in production source of every zone, packages/node included', () => {
    for (const zone of Object.keys(ZONES)) {
      expect(violationFor(zone, '@agentlink/crypto/testing', `${zone}/src/a.ts`), zone).toMatch(
        TEST_ONLY,
      );
    }
    expect(
      violationFor('packages/node', '@agentlink/crypto/testing/x', 'packages/node/src/a.ts'),
    ).toMatch(TEST_ONLY);
  });

  it('is refused in production source in every import form', () => {
    for (const code of [
      testing,
      `export { MemoryKeyStore } from '@agentlink/crypto/testing';\n`,
      `const m = await import('@agentlink/crypto/testing');\n`,
      `type T = import('@agentlink/crypto/testing').MemoryKeyStore;\n`,
    ]) {
      expect(src('packages/core', code).join('\n')).toMatch(TEST_ONLY);
    }
  });

  it('is allowed in test files, the vector harness and e2e (layering still applies)', () => {
    expect(src('packages/core', testing, 'src/a.test.ts')).toEqual([]);
    expect(src('packages/core', testing, 'test/b.test.mts')).toEqual([]);
    expect(
      violationFor('packages/core', '@agentlink/crypto/testing', 'packages/core/src/a.test.ts'),
    ).toBeNull();
    // test-vectors/ and e2e/ have no layering entry (their own ESLint configs govern them); only
    // the test-only rule is under test here.
    expect(
      violationFor('test-vectors', '@agentlink/crypto/testing', 'test-vectors/harness/x.ts') ?? '',
    ).not.toMatch(TEST_ONLY);
    expect(violationFor(null, '@agentlink/crypto/testing', 'e2e/flows/x.ts') ?? '').not.toMatch(
      TEST_ONLY,
    );
  });

  it('does not count a name that only looks like a test file', () => {
    for (const file of ['src/a.test.ts.bak', 'src/test.ts', 'src/a.testing.ts', 'src/tests/a.ts']) {
      expect(src('packages/core', testing, file).join('\n'), file).toMatch(TEST_ONLY);
    }
  });
});
