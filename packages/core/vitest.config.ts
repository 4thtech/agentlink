// Unit tests in Node. The crypto test seam `@agentlink/crypto/testing` (MemoryKeyStore,
// MemoryOwnerKeyStore and the deterministic helpers; M1-1g-b, 04 §3.1.1) has no package export and is
// never built: this alias is the only thing that resolves it, and only for tests. deps-check and
// ESLint allow it by that exact name in this package's *.test.ts files only (tools/deps-check/policy.mjs).
//
// `@agentlink/crypto` maps to the same source, so a test sees one copy of the crypto module (one
// CryptoInputError, one KeyStoreError) whether a value comes from the seam or the main entry. The
// entries are anchored: `@agentlink/crypto/keystore` is not mapped (and stays refused here).
import { defineConfig } from 'vitest/config';

const cryptoSource = (file: string): string =>
  decodeURIComponent(new URL(`../crypto/src/${file}`, import.meta.url).pathname);

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@agentlink\/crypto$/, replacement: cryptoSource('index.ts') },
      { find: /^@agentlink\/crypto\/testing$/, replacement: cryptoSource('testing.ts') },
    ],
  },
  test: {
    environment: 'node',
    // Only *.test.ts: the one test-file name every build excludes (IR-M1-1c-G2-1 L-1).
    include: ['src/**/*.test.ts'],
    // Repository-wide test timeout policy (M0-10e): 20 s, not the 5 s default (docs/process/repo-reference.md).
    testTimeout: 20_000,
  },
});
