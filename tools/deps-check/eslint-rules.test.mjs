// Fixture tests for the ESLint side of the boundary guards. Each case lints a snippet as if it
// lived at `filePath`, with the real eslint.config.mjs, and expects the boundary rules to fire.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BOUNDARY = new Set([
  'no-restricted-imports',
  'boundaries/no-bypass',
  'no-eval',
  'no-new-func',
  'no-implied-eval',
]);

let eslint;
beforeAll(() => {
  eslint = new ESLint({ cwd: REPO, overrideConfigFile: join(REPO, 'eslint.config.mjs') });
});

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
    ['@agentlink/core', 'packages/crypto/src/a.ts'],
    ['@agentlink/storage', 'packages/chain/src/a.ts'],
    ['@agentlink/node', 'packages/core/src/a.ts'],
    ['@agentlink/node', 'apps/console/src/a.ts'],
    ['@agentlink/ui', 'apps/submitter/src/a.ts'],
    ['@4thtech/agentlink', 'apps/console/src/a.ts'],
    ['@agentlink/types', 'packages/unknown/src/a.ts'],
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
    ['@agentlink/crypto', 'packages/chain/src/a.ts'],
    ['@agentlink/core', 'packages/node/src/a.ts'],
    ['@agentlink/node', 'apps/cli/src/a.ts'],
    ['@agentlink/ui', 'apps/console/src/a.ts'],
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
    [`const m = await import(\`@agentlink/node\`);`],
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
      rules(await lint('packages/crypto/src/a.ts', `await import('@agentlink/core');`)),
    ).toEqual(['boundaries/no-bypass']);
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

describe('IR-M1-1b-1 M-1: @agentlink/crypto/keystore is for KeyStore backends only', () => {
  const keystore = `import { deriveSecretKey } from '@agentlink/crypto/keystore';\nvoid deriveSecretKey;\n`;

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
      `const m = await import('@agentlink/crypto/keystore');`,
      `const m = require('@agentlink/crypto/keystore');`,
    ]) {
      expect(rules(await lint('packages/core/src/a.ts', code))).toContain('boundaries/no-bypass');
    }
  });

  it('does not apply the rule in packages/node, and keeps the main entry open in packages/core', async () => {
    // packages/node may import @agentlink/crypto only once its layering entry allows it; this
    // rule must not be what stops the KeyStore backends there.
    const messages = await lint('packages/node/src/a.ts', keystore);
    for (const { message } of messages) expect(message).not.toMatch(/may be imported only in/);
    const main = `import { bip340Verify } from '@agentlink/crypto';\nvoid bip340Verify;\n`;
    expect(await lint('packages/core/src/a.ts', main)).toEqual([]);
  });
});
