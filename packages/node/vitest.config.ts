// Unit tests in Node. Repository-wide test timeout policy (M0-10e): 20 s per test instead of the
// 5 s Vitest default, which flakes on loaded CI runners (docs/process/repo-reference.md, Testing
// expectations). Every packages/* config sets the same value; a longer limit is never lowered.
//
// M1-1g-h: the crypto test seam `@4thtech-io/crypto/testing` (the shared KeyStore conformance suite,
// runKeyStoreConformance) has no package export and is never built: this alias is the only thing
// that resolves it, and only for tests. deps-check and ESLint allow it by that exact name in this
// package's *.test.ts files only (tools/deps-check/policy.mjs). The anchored pattern maps that name
// alone; `@4thtech-io/crypto` and its /keystore entry still resolve to the built package.
import { configDefaults, defineConfig } from 'vitest/config';

// CI-E2E-BROWSER: CI runs the real-browser (Playwright) files, `*browser.test.ts`, in their own job so
// they do not share a runner with every other package's tests. AGENTLINK_CI_BROWSER_TESTS=skip leaves
// them out (ci.yml `checks`), `only` runs just them (ci.yml `e2e-browser`); unset runs everything
// (local runs, `node-os`). tools/ci/e2e-browser-split.test.mjs pins this.
const BROWSER_TESTS = '**/*browser.test.?(c|m)[jt]s?(x)';
const browserTests = process.env.AGENTLINK_CI_BROWSER_TESTS;
if (browserTests !== undefined && browserTests !== 'skip' && browserTests !== 'only') {
  throw new Error('AGENTLINK_CI_BROWSER_TESTS must be skip or only');
}
const browserSplit =
  browserTests === 'only'
    ? { include: [BROWSER_TESTS] }
    : browserTests === 'skip'
      ? { exclude: [...configDefaults.exclude, BROWSER_TESTS] }
      : {};

const cryptoTesting = decodeURIComponent(
  new URL('../crypto/src/testing.ts', import.meta.url).pathname,
);

export default defineConfig({
  resolve: {
    alias: [{ find: /^@4thtech-io\/crypto\/testing$/, replacement: cryptoTesting }],
  },
  test: {
    ...browserSplit,
    testTimeout: 20_000,
  },
});
