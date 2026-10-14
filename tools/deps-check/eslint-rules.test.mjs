// Fixture tests for the ESLint side of the boundary guards. Each case lints a snippet as if it
// lived at `filePath`, with the real eslint.config.mjs, and expects the boundary rules to fire.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BOUNDARY = new Set(['no-restricted-imports', 'boundaries/no-bypass']);

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
