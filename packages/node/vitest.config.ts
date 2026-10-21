// Unit tests in Node. Repository-wide test timeout policy (M0-10e): 20 s per test instead of the
// 5 s Vitest default, which flakes on loaded CI runners (docs/process/repo-reference.md, Testing
// expectations). Every packages/* config sets the same value; a longer limit is never lowered.
//
// M1-1g-h: the crypto test seam `@4thtech-io/crypto/testing` (the shared KeyStore conformance suite,
// runKeyStoreConformance) has no package export and is never built: this alias is the only thing
// that resolves it, and only for tests. deps-check and ESLint allow it by that exact name in this
// package's *.test.ts files only (tools/deps-check/policy.mjs). The anchored pattern maps that name
// alone; `@4thtech-io/crypto` and its /keystore entry still resolve to the built package.
import { defineConfig } from 'vitest/config';

const cryptoTesting = decodeURIComponent(
  new URL('../crypto/src/testing.ts', import.meta.url).pathname,
);

export default defineConfig({
  resolve: {
    alias: [{ find: /^@4thtech-io\/crypto\/testing$/, replacement: cryptoTesting }],
  },
  test: {
    testTimeout: 20_000,
  },
});
