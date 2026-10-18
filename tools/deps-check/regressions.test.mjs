// Regression tests for review IR-M0-10-1 (bypasses F01 to F10). Each bypass that the review found
// is a red case here, in deps-check and, where the form is visible to ESLint, in ESLint too.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkManifest, checkSource, runChecks, specProblem } from './check.mjs';
import {
  LIBRARIES,
  RESTRICTED_ENTRY_POINTS,
  SUBTLE_EXEMPT_FILES,
  ZONES,
  isTestFile,
  misnamedTestFile,
  violationFor,
} from './policy.mjs';

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
      'packages/core/package.json': JSON.stringify({ name: '@4thtech-io/core' }),
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
    ['workspace:@4thtech-io/node@*', '@4thtech-io/node'],
    ['workspace:@4thtech-io/node@^1.0.0', '@4thtech-io/node'],
  ])('rejects the workspace alias %s under another name', (spec) => {
    for (const field of ['dependencies', 'devDependencies']) {
      const problems = manifest('packages/core', { [field]: { 'keystore-impl': spec } });
      expect(problems.join('\n')).toMatch(/workspace: alias must not point to a different package/);
      expect(problems.join('\n')).toMatch(/may not import @4thtech-io\/node/);
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
      name: '@4thtech-io/node',
      dependencies: { '@4thtech-io/core': 'workspace:*' },
    });
    write('packages/core/package.json', {
      name: '@4thtech-io/core',
      devDependencies: { 'keystore-impl': 'workspace:@4thtech-io/node@*' },
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
      '@noble/*': '@4thtech-io/crypto',
      viem: '@4thtech-io/chain',
      'nostr-tools': '@4thtech-io/transport-nostr',
      aws4fetch: '@4thtech-io/storage',
    });
    expect(violationFor('packages/core', 'viem', 'packages/core/src/a.ts')).toMatch(
      /everything else uses @4thtech-io\/chain/,
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
    write('packages/core/package.json', JSON.stringify({ name: '@4thtech-io/core' }));
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
      JSON.stringify({ name: '@4thtech-io/agentlink' }),
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

describe('IR-M1-1b-1 M-1: the restricted @4thtech-io/crypto/keystore subpath', () => {
  const keystore = `import { deriveSecretKey } from '@4thtech-io/crypto/keystore';\n`;

  it('fails when packages/core imports it, in every form', () => {
    for (const code of [
      keystore,
      `export { deriveKey } from '@4thtech-io/crypto/keystore';\n`,
      `const m = await import('@4thtech-io/crypto/keystore');\n`,
      `type T = import('@4thtech-io/crypto/keystore').PublicIdentity;\n`,
    ]) {
      expect(src('packages/core', code).join('\n')).toMatch(
        /@4thtech-io\/crypto\/keystore may be imported only in packages\/node, test-vectors/,
      );
    }
    expect(
      violationFor('packages/core', '@4thtech-io/crypto/keystore', 'packages/core/src/a.ts'),
    ).toMatch(/KeyStore interface/);
  });

  // packages/node hosts the KeyStore backends. Whether it may import @4thtech-io/crypto at all is the
  // package layering (ZONES), which today does not list crypto for it; the card that adds the file
  // and keychain backends widens that. This rule must not be what stops it.
  const RESTRICTED =
    /@4thtech-io\/crypto\/keystore may be imported only in packages\/node, test-vectors/;
  const ruleFor = (zone) =>
    violationFor(zone, '@4thtech-io/crypto/keystore', `${zone}/src/a.ts`) ?? '';

  it('applies in every zone except packages/node, even where @4thtech-io/crypto is allowed', () => {
    const exempt = Object.keys(ZONES).filter((zone) => !RESTRICTED.test(ruleFor(zone)));
    expect(exempt).toEqual(['packages/node']);
    expect(
      violationFor('packages/core', '@4thtech-io/crypto', 'packages/core/src/a.ts'),
    ).toBeNull();
  });

  it('exempts packages/node (layering still applies) and allows the vector harness', () => {
    expect(ruleFor('packages/node')).not.toMatch(RESTRICTED);
    expect(src('packages/node', keystore).join('\n')).not.toMatch(RESTRICTED);
    // test-vectors has no layering entry (its own ESLint config governs its imports, and pnpm lint
    // passes with the suites importing the subpath); this rule must not name it.
    expect(ruleFor('test-vectors')).not.toMatch(RESTRICTED);
  });
});

describe('IR-M1-1g-G2-1 M-2: MemoryKeyStore lives in the one crypto test seam', () => {
  const RESTRICTED = /@4thtech-io\/crypto\/testing may be imported only in test-vectors/;
  const SEAM_SOURCE = /test seam\) may be imported only by test files/;
  const forms = [
    `import { MemoryKeyStore } from '@4thtech-io/crypto/testing';\n`,
    `export { MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';\n`,
    `const m = await import('@4thtech-io/crypto/testing');\n`,
    `type T = import('@4thtech-io/crypto/testing').MemoryKeyStore;\n`,
  ];

  it('is refused by name in production source of every zone, in every form', () => {
    for (const zone of Object.keys(ZONES)) {
      for (const code of forms) {
        expect(src(zone, code).join('\n'), `${zone}: ${code}`).toMatch(RESTRICTED);
      }
    }
  });

  it('is refused by name in test files of zones 04 §3.1.1 does not list: one seam, one rule', () => {
    // packages/core and packages/transport-nostr test files may use it (M1-1g-b, below).
    expect(src('packages/node', forms[0], 'src/a.test.ts').join('\n')).toMatch(RESTRICTED);
    expect(src('apps/cli', forms[0], 'src/a.test.ts').join('\n')).toMatch(RESTRICTED);
  });

  it('is refused by relative path from crypto production code and allowed from crypto tests', () => {
    const code = `import { MemoryKeyStore } from './testing.js';\n`;
    expect(src('packages/crypto', code, 'src/keystore-api.ts').join('\n')).toMatch(SEAM_SOURCE);
    expect(src('packages/crypto', code, 'src/memory-keystore.test.ts')).toEqual([]);
  });

  it('has no second policy entry: exactly one restricted entry names the testing subpath', () => {
    const entries = RESTRICTED_ENTRY_POINTS.filter((entry) =>
      entry.group.includes('@4thtech-io/crypto/testing'),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.zones).toEqual(['test-vectors', 'e2e']);
    expect(entries[0]?.testZones).toEqual([
      'packages/core',
      'packages/transport-nostr',
      'packages/storage',
    ]);
  });
});

describe('IR-M1-1e-1 L-1: viem is a test-only library in packages/crypto', () => {
  const code = `import { keccak256 } from 'viem';\nvoid keccak256;\n`;

  it('refuses viem in crypto runtime source, in every form', () => {
    for (const form of [
      code,
      `export * from 'viem';\n`,
      `const m = await import('viem/accounts');\n`,
      `type T = import('viem').Hex;\n`,
    ]) {
      expect(src('packages/crypto', form, 'src/eip712.ts').join('\n')).toMatch(
        /viem may be imported only in packages\/chain, apps\/pay \(and in test files of packages\/crypto\)/,
      );
    }
    expect(violationFor('packages/crypto', 'viem', 'packages/crypto/src/eip712.ts')).not.toBeNull();
  });

  it('allows viem in crypto test files only', () => {
    expect(src('packages/crypto', code, 'src/eip712.test.ts')).toEqual([]);
    expect(violationFor('packages/crypto', 'viem/accounts', 'packages/crypto/src/a.test.ts')).toBe(
      null,
    );
    // Other zones' tests get nothing from this.
    expect(violationFor('packages/core', 'viem', 'packages/core/src/a.test.ts')).not.toBeNull();
  });

  it('allows viem as a crypto devDependency, never as a runtime dependency', () => {
    expect(manifest('packages/crypto', { devDependencies: { viem: '2.57.1' } })).toEqual([]);
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
      expect(manifest('packages/crypto', { [field]: { viem: '2.57.1' } }).join('\n')).toMatch(
        /viem may be imported only in/,
      );
    }
    expect(manifest('packages/core', { devDependencies: { viem: '2.57.1' } }).join('\n')).toMatch(
      /viem may be imported only in/,
    );
  });

  it('keeps the test-only zone off the runtime zone list', () => {
    const viem = LIBRARIES.find((lib) => lib.group.includes('viem'));
    expect(viem?.zones).not.toContain('packages/crypto');
    expect(viem?.testZones).toEqual(['packages/crypto']);
  });
});

describe('M1-1c, M1-1f: the crypto test seam @4thtech-io/crypto/testing', () => {
  const seams = [
    `import { encryptPayloadWithIv } from '@4thtech-io/crypto/testing';\n`,
    `import { sealOwnerSeedWithNonce } from '@4thtech-io/crypto/testing';\n`,
  ];
  const RESTRICTED = /@4thtech-io\/crypto\/testing may be imported only in test-vectors/;

  it('fails in every zone, packages/node and packages/crypto included', () => {
    for (const zone of Object.keys(ZONES)) {
      expect(violationFor(zone, '@4thtech-io/crypto/testing', `${zone}/src/a.ts`), zone).toMatch(
        RESTRICTED,
      );
    }
    for (const code of [...seams, `const m = await import('@4thtech-io/crypto/testing');\n`]) {
      expect(src('packages/core', code).join('\n')).toMatch(RESTRICTED);
    }
  });

  it('allows the vector harness', () => {
    expect(
      violationFor('test-vectors', '@4thtech-io/crypto/testing', 'test-vectors/a.ts') ?? '',
    ).not.toMatch(RESTRICTED);
  });

  // Inside packages/crypto the seam source is reachable by a relative path, which the entry above
  // (by package name) does not see. tsc builds every file a built module imports, so one production
  // import would also put the seam into dist/.
  const SEAM_SOURCE = /test seam\) may be imported only by test files/;

  it('refuses a relative import of the seam source from crypto production code, in every form', () => {
    for (const code of [
      `import { hpkeOpen } from './testing.js';\n`,
      `import { pairingDigest } from './testing';\n`,
      `export * from './testing.js';\n`,
      `const m = await import('./testing.js');\n`,
      `type T = import('./testing.js').HpkeSealed;\n`,
    ]) {
      expect(src('packages/crypto', code, 'src/hpke.ts').join('\n')).toMatch(SEAM_SOURCE);
    }
    expect(
      src('packages/crypto', `export * from '../testing.js';\n`, 'src/x/a.ts').join('\n'),
    ).toMatch(SEAM_SOURCE);
  });

  it('allows the seam source in crypto test files, and other relative imports everywhere', () => {
    expect(
      src('packages/crypto', `import { hpkeOpen } from './testing.js';\n`, 'src/hpke.test.ts'),
    ).toEqual([]);
    expect(src('packages/crypto', `import { wrapCek } from './hpke.js';\n`, 'src/a.ts')).toEqual(
      [],
    );
    expect(src('packages/core', `import { x } from './testing.js';\n`, 'src/a.ts')).toEqual([]);
  });
});

describe('M1-1g-b (IR-M1-1g-G2-1 R2-L-1): the test seam in package test files (04 §3.1.1)', () => {
  // 04 §3.1.1: the test doubles are "in an entry point that deps-check allows only in tests,
  // test-vectors and e2e, never in production src". Test files of the packages that need a
  // MemoryKeyStore (core M1-7a, transport-nostr M1-5a) may import it by package name.
  const RESTRICTED = /@4thtech-io\/crypto\/testing may be imported only in test-vectors/;
  const SEAM_SOURCE = /test seam\) may be imported only by test files/;
  const ZONES_WITH_TESTS = ['packages/core', 'packages/transport-nostr'];
  const forms = [
    `import { MemoryKeyStore } from '@4thtech-io/crypto/testing';\n`,
    `export { MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';\n`,
    `const m = await import('@4thtech-io/crypto/testing');\n`,
    `type T = import('@4thtech-io/crypto/testing').MemoryKeyStore;\n`,
  ];

  it('allows it by package name in test files of core and transport-nostr, in every form', () => {
    for (const zone of ZONES_WITH_TESTS) {
      for (const name of ['src/a.test.ts', 'src/deep/er/b.test.ts']) {
        for (const code of forms) expect(src(zone, code, name), `${zone} ${name}`).toEqual([]);
        expect(violationFor(zone, '@4thtech-io/crypto/testing', `${zone}/${name}`)).toBeNull();
      }
    }
  });

  it('allows e2e and test-vectors (test-only directories, never built)', () => {
    for (const zone of ['e2e', 'test-vectors']) {
      expect(
        violationFor(zone, '@4thtech-io/crypto/testing', `${zone}/a.ts`) ?? '',
        zone,
      ).not.toMatch(RESTRICTED);
    }
  });

  it('still refuses it by name in production files of the same packages', () => {
    for (const zone of ZONES_WITH_TESTS) {
      for (const name of ['src/index.ts', 'src/a.ts', 'src/testing.ts', 'src/test/helpers.ts']) {
        for (const code of forms) {
          expect(src(zone, code, name).join('\n'), `${zone} ${name} ${code}`).toMatch(RESTRICTED);
        }
      }
    }
  });

  it('still refuses it in test files of every other zone', () => {
    for (const zone of Object.keys(ZONES).filter((z) => !ZONES_WITH_TESTS.includes(z))) {
      if (zone === 'packages/crypto') continue; // its own tests use the relative path
      expect(
        violationFor(zone, '@4thtech-io/crypto/testing', `${zone}/src/a.test.ts`),
        zone,
      ).toMatch(RESTRICTED);
    }
  });

  it('refuses a relative path to the seam source from those packages, test files included', () => {
    for (const zone of ZONES_WITH_TESTS) {
      for (const name of ['src/a.ts', 'src/a.test.ts']) {
        const problems = src(
          zone,
          `import { MemoryKeyStore } from '../../crypto/src/testing.js';\n`,
          name,
        );
        expect(problems.join('\n'), `${zone} ${name}`).toMatch(/leaves/);
      }
      expect(
        src(zone, `export * from '../../crypto/src/testing';\n`, 'src/a.ts').join('\n'),
      ).toMatch(SEAM_SOURCE);
    }
  });

  it('refuses deep dist/, src/ and subpaths of the seam, in test files too: the exact name only', () => {
    for (const zone of ZONES_WITH_TESTS) {
      for (const name of ['src/a.ts', 'src/a.test.ts']) {
        for (const specifier of [
          '@4thtech-io/crypto/src/testing',
          '@4thtech-io/crypto/src/testing.ts',
          '@4thtech-io/crypto/dist/testing.js',
          '@4thtech-io/crypto/testing/../src/testing.js',
          '@4thtech-io/crypto/testing/index.js',
          '@4thtech-io/crypto/./src/testing.js',
        ]) {
          expect(
            violationFor(zone, specifier, `${zone}/${name}`),
            `${zone} ${name} ${specifier}`,
          ).not.toBeNull();
        }
      }
    }
  });

  // IR-M1-1c-G2-1 L-1: every package build excludes exactly `src/**/*.test.ts`, so that is the only
  // test-file name the guards accept. Any other test-like name is treated as production code (the
  // seam and test-only libraries are refused) and is reported by deps-check (rename it).
  const OTHER_NAMES = [
    'src/a.test.mts',
    'src/a.test.cts',
    'src/a.test.tsx',
    'src/a.test.js',
    'src/a.test.mjs',
    'src/a.spec.ts',
    'src/a.spec.mts',
  ];

  it('treats *.test.mts, *.test.cts, *.spec.* and other test-like names as production code', () => {
    for (const name of OTHER_NAMES) {
      expect(isTestFile(`packages/core/${name}`), name).toBe(false);
      expect(src('packages/core', forms[0], name).join('\n'), name).toMatch(RESTRICTED);
      expect(
        src('packages/crypto', `import { hpkeOpen } from './testing.js';\n`, name).join('\n'),
        name,
      ).toMatch(SEAM_SOURCE);
      expect(src('packages/crypto', `import 'viem';\n`, name).join('\n'), name).toMatch(/viem/);
    }
    expect(isTestFile('packages/core/src/a.test.ts')).toBe(true);
  });

  it('reports any test-like file name other than *.test.ts in packages and apps', () => {
    for (const name of OTHER_NAMES) {
      expect(misnamedTestFile(`packages/core/${name}`), name).toMatch(/\*\.test\.ts/);
    }
    for (const name of [
      'src/a.test.ts',
      'src/a.ts',
      'src/testing.ts',
      'src/contest.ts',
      'src/latest.mts',
    ]) {
      expect(misnamedTestFile(`packages/core/${name}`), name).toBeNull();
    }
  });

  const dirs = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('fails the repository scan for a planted src/x.test.mts that imports the seam', () => {
    const root = mkdtempSync(join(tmpdir(), 'deps-check-seam-'));
    dirs.push(root);
    const write = (path, text) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    };
    write('packages/core/package.json', JSON.stringify({ name: '@4thtech-io/core' }));
    write('packages/core/src/ok.test.ts', forms[0]);
    write('packages/core/src/x.test.mts', forms[0]);
    const { problems } = runChecks(root);
    expect(problems.some((p) => p.includes('src/ok.test.ts'))).toBe(false);
    expect(problems.some((p) => p.includes('src/x.test.mts') && /\*\.test\.ts/.test(p))).toBe(true);
    expect(problems.some((p) => p.includes('src/x.test.mts') && RESTRICTED.test(p))).toBe(true);
  });
});

describe('IR-M1-1g-b-1 L-2: non-canonical workspace specifiers are refused', () => {
  const NON_CANONICAL = /non-canonical/;
  const bad = [
    '@4thtech-io/crypto//testing',
    '@4thtech-io/crypto/Testing',
    '@4thtech-io/Crypto/testing',
    '@4thTech-io/crypto',
    '@4thtech-io/crypto/testing/',
    '@4thtech-io/crypto/./testing',
    '@4thtech-io/crypto/x/../testing',
    '@4thtech-io/AgentLink',
  ];

  it('refuses each form in production and test files of every zone', () => {
    for (const zone of [...Object.keys(ZONES), 'test-vectors', 'e2e']) {
      for (const name of ['src/a.ts', 'src/a.test.ts']) {
        for (const specifier of bad) {
          expect(
            violationFor(zone, specifier, `${zone}/${name}`),
            `${zone} ${name} ${specifier}`,
          ).toMatch(NON_CANONICAL);
        }
      }
    }
  });

  it('finds a planted static import in a core test file', () => {
    for (const specifier of bad) {
      const code = `export * from '${specifier}';\n`;
      expect(src('packages/core', code, 'src/a.test.ts').join('\n'), specifier).toMatch(
        NON_CANONICAL,
      );
    }
  });

  it('leaves canonical specifiers and other scopes alone', () => {
    expect(
      violationFor('packages/core', '@4thtech-io/crypto', 'packages/core/src/a.ts'),
    ).toBeNull();
    expect(
      violationFor('packages/core', '@4thtech-io/crypto/testing', 'packages/core/src/a.test.ts'),
    ).toBeNull();
    expect(violationFor('packages/types', 'zod', 'packages/types/src/a.ts')).toBeNull();
  });
});

describe('IR-M1-1f-1 L-2: deep imports into a workspace package', () => {
  const DEEP = /deep import/;

  it('refuses dist/ and src/ subpaths of every workspace package, in every zone', () => {
    for (const zone of Object.keys(ZONES)) {
      for (const specifier of [
        '@4thtech-io/crypto/dist/keystore-file.js',
        '@4thtech-io/crypto/dist',
        '@4thtech-io/crypto/src/testing.ts',
        '@4thtech-io/types/dist/index.js',
      ]) {
        expect(violationFor(zone, specifier, `${zone}/src/a.ts`), `${zone} ${specifier}`).toMatch(
          DEEP,
        );
      }
    }
    expect(
      violationFor('test-vectors', '@4thtech-io/crypto/dist/keystore.js', 'test-vectors/a.ts'),
    ).toMatch(DEEP);
  });

  it('finds a planted static import in packages/core', () => {
    const code = `import { sealOwnerSeedWithNonceUnsafe } from '@4thtech-io/crypto/dist/keystore-file.js';\n`;
    expect(src('packages/core', code).join('\n')).toMatch(DEEP);
  });

  it('leaves the declared entry points alone', () => {
    expect(
      violationFor('packages/core', '@4thtech-io/crypto', 'packages/core/src/a.ts'),
    ).toBeNull();
    expect(
      violationFor('packages/node', '@4thtech-io/crypto/keystore', 'packages/node/src/a.ts') ?? '',
    ).not.toMatch(DEEP);
  });
});

describe('M1-5b-b: relay sockets only in packages/node', () => {
  it('allows ws in packages/node and refuses it everywhere else', () => {
    expect(violationFor('packages/node', 'ws', 'packages/node/src/relay-io.ts')).toBeNull();
    for (const zone of ['packages/core', 'packages/transport-nostr', 'apps/cli', 'apps/console']) {
      expect(violationFor(zone, 'ws', `${zone}/src/a.ts`)).toMatch(/@4thtech-io\/node/);
      expect(violationFor(zone, 'ws/lib/websocket.js', `${zone}/src/a.ts`)).toMatch(
        /@4thtech-io\/node/,
      );
    }
  });

  it('allows ws as a runtime dependency of packages/node only', () => {
    expect(manifest('packages/node', { dependencies: { ws: '8.22.0' } })).toEqual([]);
    expect(manifest('packages/core', { dependencies: { ws: '8.22.0' } })).not.toEqual([]);
  });
});
