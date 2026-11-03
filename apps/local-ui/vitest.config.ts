// Unit tests: the repository-wide 20 s test timeout (M0-10e); DOM tests opt into jsdom with a
// per-file `@vitest-environment` comment.
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

export default defineConfig({
  test: {
    ...browserSplit,
    // Tests that read their stylesheet as text (`?raw`) need it listed here; the default config would replace it with "".
    css: {
      include: [
        /messages\.css/,
        /home\.css/,
        /contacts\.css/,
        /approvals\.css/,
        /board\.css/,
        /activity\.css/,
        /pulse\.css/,
        /about\.css/,
        /proofs\.css/,
        /app\.css/,
        /compact\.css/,
        /map\.css/,
        /moving\.css/,
        /welcome\.css/,
        /agents\.css/,
        // The real-browser layout test reads the shared UI stylesheets as text (HOTFIX-045-PASTE-FIELD).
        /ui\/src\/(components|tokens)\/.*\.css/,
      ],
    },
    // Loads the lazy parts once, so tests can render them synchronously (UI-REFRESH-u).
    setupFiles: ['./src/test-setup.ts'],
    testTimeout: 20_000,
  },
});
