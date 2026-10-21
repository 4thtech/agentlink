// Fixture tests for the ESLint side of the boundary guards. Each case lints a snippet as if it
// lived at `filePath`, with the real eslint.config.mjs, and expects the boundary rules to fire.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';
import { violationFor } from './policy.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BOUNDARY = new Set([
  'no-restricted-imports',
  'boundaries/no-bypass',
  'no-eval',
  'no-new-func',
  'no-implied-eval',
  'no-restricted-properties',
]);

let eslint;
// The first lintText loads the config, the TypeScript parser and the plugins, which can take more
// than a test's timeout on a cold CI runner. Warm up here, under an explicit hook timeout, so every
// test measures only a warm lint (the tools-wide test timeout is set in tools/vitest.config.mjs).
beforeAll(async () => {
  eslint = new ESLint({ cwd: REPO, overrideConfigFile: join(REPO, 'eslint.config.mjs') });
  await eslint.lintText('export {};\n', { filePath: join(REPO, 'packages/core/src/warmup.ts') });
}, 60_000);

async function lint(filePath, code) {
  const [result] = await eslint.lintText(code, { filePath: join(REPO, filePath) });
  return result.messages.filter((message) => BOUNDARY.has(message.ruleId));
}

const rules = (messages) => messages.map((message) => message.ruleId);

describe('static imports (no-restricted-imports zones)', () => {
  it.each([
    ['@noble/curves', 'packages/chain/src/a.ts'],
    ['@noble/hashes/sha2', 'packages/core/src/a.ts'],
    ['@hpke/core', 'packages/storage/src/a.ts'],
    ['nostr-tools', 'packages/chain/src/a.ts'],
    ['nostr-tools/pure', 'packages/core/src/a.ts'],
    ['viem', 'packages/storage/src/a.ts'],
    ['viem/chains', 'apps/submitter/src/a.ts'],
    ['aws4fetch', 'packages/transport-nostr/src/a.ts'],
    ['node:fs', 'packages/core/src/a.ts'],
    ['fs', 'packages/chain/src/a.ts'],
    ['node:crypto', 'packages/node/src/a.ts'],
    ['crypto', 'apps/cli/src/a.ts'],
    ['@4thtech-io/core', 'packages/crypto/src/a.ts'],
    ['@4thtech-io/storage', 'packages/chain/src/a.ts'],
    ['@4thtech-io/node', 'packages/core/src/a.ts'],
    ['@4thtech-io/node', 'apps/console/src/a.ts'],
    ['@4thtech-io/ui', 'apps/submitter/src/a.ts'],
    ['@4thtech-io/agentlink', 'apps/console/src/a.ts'],
    ['@4thtech-io/types', 'packages/unknown/src/a.ts'],
  ])('rejects import of %s in %s', async (specifier, filePath) => {
    const messages = await lint(filePath, `import * as x from '${specifier}';\nvoid x;\n`);
    expect(rules(messages)).toEqual(['no-restricted-imports']);
  });

  it.each([
    ['@noble/curves', 'packages/crypto/src/a.ts'],
    ['@hpke/core', 'packages/crypto/src/a.ts'],
    ['nostr-tools', 'packages/transport-nostr/src/a.ts'],
    ['viem', 'packages/chain/src/a.ts'],
    ['viem', 'apps/pay/src/a.ts'],
    ['aws4fetch', 'packages/storage/src/a.ts'],
    ['node:fs', 'packages/node/src/a.ts'],
    ['node:path', 'apps/cli/src/a.ts'],
    ['@4thtech-io/crypto', 'packages/chain/src/a.ts'],
    ['@4thtech-io/core', 'packages/node/src/a.ts'],
    ['@4thtech-io/node', 'apps/cli/src/a.ts'],
    ['@4thtech-io/ui', 'apps/console/src/a.ts'],
  ])('allows import of %s in %s', async (specifier, filePath) => {
    expect(await lint(filePath, `import * as x from '${specifier}';\nvoid x;\n`)).toEqual([]);
  });
});

describe('boundaries/no-bypass (forms no-restricted-imports cannot see)', () => {
  it.each([
    [`const m = await import('@noble/curves');`],
    [`const m = await import('node:fs');`],
    [`const m = require('viem');`],
    [`import fs = require('node:fs');`],
    [`type T = import('@hpke/core').CipherSuite;`],
    [`const m = await import(\`@4thtech-io/node\`);`],
  ])('rejects %s', async (code) => {
    expect(rules(await lint('packages/core/src/a.ts', code))).toContain('boundaries/no-bypass');
  });

  it('rejects a computed specifier', async () => {
    const messages = await lint('apps/cli/src/a.ts', `const m = await import(name);`);
    expect(rules(messages)).toEqual(['boundaries/no-bypass']);
    expect(messages[0].message).toMatch(/non-literal/);
  });

  it('applies the layering to dynamic imports as well', async () => {
    expect(await lint('packages/crypto/src/a.ts', `await import('@noble/curves');`)).toEqual([]);
    expect(
      rules(await lint('packages/crypto/src/a.ts', `await import('@4thtech-io/core');`)),
    ).toEqual(['boundaries/no-bypass']);
  });

  it('refuses the crypto test seam source by a relative path, except in test files', async () => {
    const code = `import { hpkeOpen } from './testing.js';\nvoid hpkeOpen;\n`;
    expect(rules(await lint('packages/crypto/src/a.ts', code))).toEqual(['boundaries/no-bypass']);
    expect(rules(await lint('packages/crypto/src/a.ts', `await import('./testing.js');`))).toEqual([
      'boundaries/no-bypass',
    ]);
    expect(await lint('packages/crypto/src/a.test.ts', code)).toEqual([]);
  });

  it('rejects a relative import that leaves the package', async () => {
    const messages = await lint(
      'packages/chain/src/a.ts',
      `export * from '../../crypto/src/index.js';`,
    );
    expect(rules(messages)).toEqual(['boundaries/no-bypass']);
    expect(await lint('packages/chain/src/a.ts', `export * from './b.js';`)).toEqual([]);
    expect(
      rules(await lint('packages/chain/src/a.ts', `await import('../../core/src/x.js');`)),
    ).toEqual(['boundaries/no-bypass']);
  });

  it.each([
    [`crypto.subtle.digest('SHA-256', d);`],
    [`globalThis.crypto.subtle.digest('SHA-256', d);`],
    [`const c = globalThis.crypto; c['subtle'];`],
    [`const { subtle } = globalThis.crypto; void subtle;`],
  ])('rejects crypto.subtle outside packages/crypto: %s', async (code) => {
    const messages = await lint('packages/core/src/a.ts', code);
    expect(rules(messages)).toContain('boundaries/no-bypass');
    expect(messages.find((m) => m.ruleId === 'boundaries/no-bypass').message).toMatch(/subtle/);
  });

  it('allows crypto.subtle in packages/crypto', async () => {
    expect(
      await lint('packages/crypto/src/a.ts', `globalThis.crypto.subtle.digest('SHA-256', d);`),
    ).toEqual([]);
  });

  it('applies to test files in the zone as well', async () => {
    expect(rules(await lint('packages/chain/test/a.test.ts', `import 'node:fs';`))).toEqual([
      'no-restricted-imports',
    ]);
  });
});

// String timers are covered by deps-check (regressions.test.mjs): the core no-implied-eval rule only
// sees timers that resolve to a declared global, and shared packages declare none.
describe('review IR-M0-10-1 regressions (ESLint side)', () => {
  it.each([
    [`process.getBuiltinModule('crypto').createHash('sha256');`, 'apps/cli'],
    [`process['getBuiltinModule']('crypto');`, 'packages/core'],
    [`const { getBuiltinModule } = process; void getBuiltinModule;`, 'apps/cli'],
    [`process.binding('crypto');`, 'apps/cli'],
    [`process.mainModule.require('crypto');`, 'packages/node'],
    [`module.require('node:crypto');`, 'apps/cli'],
    [`const r = require; r('node:crypto');`, 'apps/cli'],
    [`require.call(null, 'viem');`, 'packages/core'],
    [`import { createRequire } from 'node:module'; createRequire(import.meta.url);`, 'apps/cli'],
    [`import { createRequire } from 'module'; createRequire(import.meta.url);`, 'packages/node'],
    [`Reflect.get(globalThis.crypto, 'subtle');`, 'packages/core'],
    [`Object.getOwnPropertyDescriptor(crypto, 'subtle');`, 'packages/core'],
    [`declare const k: string; void globalThis.crypto[k];`, 'packages/core'],
    [`module.constructor._load('viem');`, 'packages/core'],
    [`const m = module; m.require('x');`, 'apps/cli'],
    [`eval('1');`, 'packages/core'],
    [`new Function('return import("viem")');`, 'packages/core'],
  ])('rejects %s in %s', async (code, zone) => {
    expect((await lint(`${zone}/src/a.ts`, code)).length).toBeGreaterThan(0);
  });

  it('lints files in a src/dist directory (build output is ignored only at the package root)', async () => {
    const messages = await lint('packages/core/src/dist/x.ts', `export * from 'viem';`);
    expect(rules(messages)).toEqual(['no-restricted-imports']);
  });

  it('allows a direct literal require, a declared require and unrelated binding/require names', async () => {
    const code = `declare function require(n: string): unknown;\nrequire('node:fs');\nconst o = { binding: 1 }; void o.binding;`;
    expect(await lint('packages/node/src/a.ts', code)).toEqual([]);
  });
});

describe('IR-M1-1b-1 M-1: @4thtech-io/crypto/keystore is for KeyStore backends only', () => {
  const keystore = `import { deriveSecretKey } from '@4thtech-io/crypto/keystore';\nvoid deriveSecretKey;\n`;

  it.each([
    'packages/core/src/a.ts',
    'packages/tools/src/a.ts',
    'packages/chain/src/a.ts',
    'apps/cli/src/a.ts',
    'apps/console/src/a.ts',
    'packages/unknown/src/a.ts',
  ])('rejects a static import in %s', async (filePath) => {
    expect(rules(await lint(filePath, keystore))).toContain('no-restricted-imports');
  });

  it('rejects a dynamic import and require in packages/core', async () => {
    for (const code of [
      `const m = await import('@4thtech-io/crypto/keystore');`,
      `const m = require('@4thtech-io/crypto/keystore');`,
    ]) {
      expect(rules(await lint('packages/core/src/a.ts', code))).toContain('boundaries/no-bypass');
    }
  });

  it('does not apply the rule in packages/node, and keeps the main entry open in packages/core', async () => {
    // packages/node may import @4thtech-io/crypto only once its layering entry allows it; this
    // rule must not be what stops the KeyStore backends there.
    const messages = await lint('packages/node/src/a.ts', keystore);
    for (const { message } of messages) expect(message).not.toMatch(/may be imported only in/);
    const main = `import { bip340Verify } from '@4thtech-io/crypto';\nvoid bip340Verify;\n`;
    expect(await lint('packages/core/src/a.ts', main)).toEqual([]);
  });
});

describe('IR-M1-1g-G2-1 M-2: MemoryKeyStore lives in the one crypto test seam', () => {
  const byName = `import { MemoryKeyStore } from '@4thtech-io/crypto/testing';\nvoid MemoryKeyStore;\n`;
  const relative = `import { MemoryKeyStore } from './testing.js';\nvoid MemoryKeyStore;\n`;

  it.each(['packages/core/src/a.ts', 'packages/node/src/a.ts', 'apps/cli/src/a.ts'])(
    'rejects it by name in production source %s',
    async (filePath) => {
      const messages = await lint(filePath, byName);
      expect(messages.map((m) => m.message).join('\n')).toMatch(
        /@4thtech-io\/crypto\/testing may be imported only in test-vectors/,
      );
    },
  );

  it('rejects it by name in a test file of a zone 04 §3.1.1 does not list', async () => {
    for (const filePath of ['packages/chain/src/a.test.ts', 'apps/cli/src/a.test.ts']) {
      expect(rules(await lint(filePath, byName)), filePath).toContain('no-restricted-imports');
    }
  });

  it('rejects a relative import from crypto production code, allows it in crypto tests', async () => {
    expect(rules(await lint('packages/crypto/src/keystore-api.ts', relative))).toEqual([
      'boundaries/no-bypass',
    ]);
    expect(await lint('packages/crypto/src/memory-keystore.test.ts', relative)).toEqual([]);
  });
});

describe('M1-1g-b (IR-M1-1g-G2-1 R2-L-1): the test seam in core and transport-nostr tests', () => {
  const byName = `import { MemoryKeyStore } from '@4thtech-io/crypto/testing';\nvoid MemoryKeyStore;\n`;
  const dynamic = `const m = await import('@4thtech-io/crypto/testing');\nvoid m;\n`;
  const RESTRICTED = /@4thtech-io\/crypto\/testing may be imported only in test-vectors/;
  const zones = ['packages/core', 'packages/transport-nostr'];

  it.each(zones)('allows it by name in %s test files, static and dynamic', async (zone) => {
    for (const code of [byName, dynamic]) {
      expect(await lint(`${zone}/src/a.test.ts`, code)).toEqual([]);
      expect(await lint(`${zone}/src/sub/b.test.ts`, code)).toEqual([]);
    }
  });

  it.each(zones)('still rejects it in %s production files, static and dynamic', async (zone) => {
    for (const code of [byName, dynamic]) {
      const messages = await lint(`${zone}/src/a.ts`, code);
      expect(messages.map((m) => m.message).join('\n')).toMatch(RESTRICTED);
    }
  });

  it.each(['a.test.mts', 'a.test.cts', 'a.spec.ts', 'a.test.tsx'])(
    'treats packages/core/src/%s as production code',
    async (name) => {
      const messages = await lint(`packages/core/src/${name}`, byName);
      expect(messages.map((m) => m.message).join('\n')).toMatch(RESTRICTED);
    },
  );

  it('rejects deep and sub paths of the seam in test files', async () => {
    for (const specifier of [
      '@4thtech-io/crypto/src/testing.js',
      '@4thtech-io/crypto/dist/testing.js',
      '@4thtech-io/crypto/testing/index.js',
    ]) {
      const code = `import * as m from '${specifier}';\nvoid m;\n`;
      expect(await lint('packages/core/src/a.test.ts', code), specifier).not.toEqual([]);
    }
  });

  it('rejects a cross-package relative path to the seam source in test files', async () => {
    const code = `import { MemoryKeyStore } from '../../crypto/src/testing.js';\nvoid MemoryKeyStore;\n`;
    expect(rules(await lint('packages/core/src/a.test.ts', code))).toContain(
      'boundaries/no-bypass',
    );
  });
});

describe('IR-M1-1g-b-1 L-1, L-2: dot, empty and case-variant segments in static imports', () => {
  const bad = [
    '@4thtech-io/crypto/./testing',
    '@4thtech-io/crypto/x/../testing',
    '@4thtech-io/crypto//testing',
    '@4thtech-io/crypto/Testing',
    '@4thtech-io/Crypto/testing',
  ];

  it.each(['packages/core/src/a.ts', 'packages/core/src/a.test.ts'])(
    'rejects each form in %s, static import and re-export',
    async (filePath) => {
      for (const specifier of bad) {
        for (const code of [
          `import * as m from '${specifier}';\nvoid m;\n`,
          `export * from '${specifier}';\n`,
        ]) {
          const messages = await lint(filePath, code);
          expect(messages.map((m) => m.message).join('\n'), `${specifier}: ${code}`).toMatch(
            /non-canonical/,
          );
        }
      }
    },
  );

  it('leaves the canonical seam import alone in a core test file', async () => {
    const code = `import { MemoryKeyStore } from '@4thtech-io/crypto/testing';\nvoid MemoryKeyStore;\n`;
    expect(await lint('packages/core/src/a.test.ts', code)).toEqual([]);
  });
});

describe('IR-M1-1e-1 L-1: viem only in packages/crypto test files', () => {
  const code = `import { keccak256 } from 'viem';\nvoid keccak256;\n`;

  it('rejects viem in crypto runtime source', async () => {
    expect(rules(await lint('packages/crypto/src/eip712.ts', code))).toEqual([
      'no-restricted-imports',
    ]);
    const dynamic = `const m = await import('viem');\nvoid m;\n`;
    expect(rules(await lint('packages/crypto/src/a.ts', dynamic))).toContain(
      'boundaries/no-bypass',
    );
  });

  it('allows viem in crypto test files and keeps the other crypto rules there', async () => {
    expect(await lint('packages/crypto/src/eip712.test.ts', code)).toEqual([]);
    const aws = `import * as x from 'aws4fetch';\nvoid x;\n`;
    expect(rules(await lint('packages/crypto/src/a.test.ts', aws))).toEqual([
      'no-restricted-imports',
    ]);
    expect(rules(await lint('packages/core/src/a.test.ts', code))).toEqual([
      'no-restricted-imports',
    ]);
  });
});

describe('IR-M1-1f-1 L-2: no deep imports into a workspace package (dist/, src/)', () => {
  it.each([
    `import { sealOwnerSeedWithNonceUnsafe } from '@4thtech-io/crypto/dist/keystore-file.js';`,
    `import { deriveSecretKey } from '@4thtech-io/crypto/dist/keystore.js';`,
    `import * as m from '@4thtech-io/crypto/dist';`,
    `import { argon2idRaw } from '@4thtech-io/crypto/src/argon2.js';`,
    `import * as m from '@4thtech-io/crypto/src/testing';`,
  ])('rejects %s in packages/core and packages/node', async (code) => {
    for (const filePath of ['packages/core/src/a.ts', 'packages/node/src/a.ts']) {
      const messages = await lint(filePath, `${code}\n`);
      expect(rules(messages), filePath).toContain('no-restricted-imports');
      expect(messages.map((m) => m.message).join('\n')).toMatch(/deep import/);
    }
  });

  it('rejects a dynamic deep import', async () => {
    const code = `const m = await import('@4thtech-io/crypto/dist/keystore-file.js');\n`;
    expect(rules(await lint('packages/core/src/a.ts', code))).toContain('boundaries/no-bypass');
  });

  it('keeps the package entry points open', async () => {
    const main = `import { bip340Verify } from '@4thtech-io/crypto';\nvoid bip340Verify;\n`;
    expect(await lint('packages/core/src/a.ts', main)).toEqual([]);
  });
});

describe('IR-M1-9k-1 F01: the crypto test seam in apps/cli/test test files only', () => {
  const byName = `import { MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';\nvoid MemoryOwnerKeyStore;\n`;
  const dynamic = `const m = await import('@4thtech-io/crypto/testing');\nvoid m;\n`;
  const subpath = `import { x } from '@4thtech-io/crypto/testing/deep';\nvoid x;\n`;

  it('allows it by name in apps/cli/test/**/*.test.ts, static and dynamic', async () => {
    for (const code of [byName, dynamic]) {
      expect(await lint('apps/cli/test/a.test.ts', code)).toEqual([]);
      expect(await lint('apps/cli/test/sub/b.test.ts', code)).toEqual([]);
    }
  });

  it.each([
    'apps/cli/src/a.ts',
    'apps/cli/src/a.test.ts',
    'apps/cli/src/runtime/a.test.ts',
    'apps/cli/test/fixtures/helper.ts',
    'apps/cli/test/a.test.mts',
    'apps/cli/testing/a.test.ts',
  ])('still rejects it in %s (production src, src tests, non-test files)', async (filePath) => {
    for (const code of [byName, dynamic]) {
      expect(rules(await lint(filePath, code)).length, filePath).toBeGreaterThan(0);
    }
  });

  it('never allows a subpath of the seam, even in apps/cli/test', async () => {
    expect(rules(await lint('apps/cli/test/a.test.ts', subpath)).length).toBeGreaterThan(0);
  });

  it('deps-check decides the same (policy.violationFor)', () => {
    expect(
      violationFor('apps/cli', '@4thtech-io/crypto/testing', 'apps/cli/test/a.test.ts'),
    ).toBeNull();
    for (const file of ['apps/cli/src/a.ts', 'apps/cli/src/a.test.ts', 'apps/cli/test/x.ts']) {
      expect(violationFor('apps/cli', '@4thtech-io/crypto/testing', file), file).not.toBeNull();
    }
  });
});

// IR-M1-4a-2 R-3 (M1-4b): only the platform's address-checked RPC fetch may carry the brand
// @4thtech-io/chain createReadClient requires, so production code may not call Symbol.for outside
// the two files that set and check it. A guard, not a security boundary (the runtime check also
// refuses the global fetch).
describe('Symbol.for (the address-checked RPC fetch brand)', () => {
  const BRAND = "Symbol.for('agentlink.address-checked-rpc-fetch');";
  it.each([
    'packages/core/src/a.ts',
    'packages/chain/src/a.ts',
    'apps/cli/src/a.ts',
    'packages/node/src/a.ts',
  ])('is refused in %s', async (file) => {
    expect(rules(await lint(file, BRAND))).toEqual(['no-restricted-properties']);
  });
  it.each([
    'packages/node/src/rpc-fetch.ts',
    'packages/chain/src/clients/checked-fetch.ts',
    'packages/chain/src/clients/clients.test.ts',
  ])('is allowed in %s', async (file) => {
    expect(await lint(file, BRAND)).toEqual([]);
  });
  // IR-M1-4b-1 L-1: an alias or a computed member reaches the same function.
  it.each([
    "const S = Symbol; S['for']('agentlink.address-checked-rpc-fetch');",
    "const S = Symbol; S.for('agentlink.address-checked-rpc-fetch');",
    "Symbol['for']('agentlink.address-checked-rpc-fetch');",
  ])('refuses the alias or computed form %s', async (code) => {
    expect(rules(await lint('packages/core/src/a.ts', code))).toEqual(['no-restricted-properties']);
  });
});
