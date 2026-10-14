// Cross-runtime vector harness (M0-9, 04 §8.2). One test file, harness/vectors.test.ts, runs in five
// runtimes. Each project provides the runtime it expects (`vectorsRuntime`); the test compares that
// with what the engine reports, so a project that silently falls back to Node fails. Run it through
// `pnpm vectors:check` (tools/vectors/check.mjs), which also requires every runtime to have run every
// case and that the run changed nothing under test-vectors/.
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

const SHARED = 'harness/vectors.test.ts';

// Suites test the source of @agentlink/crypto, not a build of it: the vectors job does not build,
// and a stale dist/ must never be what passes. Inline projects do not inherit a root `resolve`, so
// every project repeats it.
// The entries are exact (anchored) so the restricted subpath `@agentlink/crypto/keystore`
// (IR-M1-1b-1 M-1) maps to its own source file instead of a path under index.ts.
// The Node project's policy-form check (M1-1h-c) reads @agentlink/types' source the same way.
const packageSource = (pkg: string, file: string): string =>
  decodeURIComponent(new URL(`../packages/${pkg}/src/${file}`, import.meta.url).pathname);
const cryptoSource = (file: string): string => packageSource('crypto', file);
const resolve = {
  alias: [
    { find: /^@agentlink\/crypto$/, replacement: cryptoSource('index.ts') },
    { find: /^@agentlink\/crypto\/keystore$/, replacement: cryptoSource('keystore.ts') },
    { find: /^@agentlink\/types$/, replacement: packageSource('types', 'index.ts') },
  ],
};

export default defineConfig({
  test: {
    projects: [
      {
        resolve,
        test: {
          name: 'node',
          environment: 'node',
          include: [
            SHARED,
            'harness/schema.test.ts',
            'harness/compare.test.ts',
            'harness/policy-form.test.ts',
          ],
          provide: { vectorsRuntime: 'node' },
        },
      },
      {
        resolve,
        test: {
          name: 'browser',
          include: [SHARED],
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            // Failure screenshots would be written next to the tests, inside test-vectors/.
            screenshotFailures: false,
            instances: [
              { browser: 'chromium', provide: { vectorsRuntime: 'chromium' } },
              { browser: 'firefox', provide: { vectorsRuntime: 'firefox' } },
              { browser: 'webkit', provide: { vectorsRuntime: 'webkit' } },
            ],
          },
        },
      },
      {
        plugins: [
          cloudflareTest({
            miniflare: {
              compatibilityDate: '2026-08-01',
              compatibilityFlags: ['nodejs_compat'],
            },
          }),
        ],
        resolve,
        test: {
          name: 'workers',
          include: [SHARED],
          provide: { vectorsRuntime: 'workerd' },
        },
      },
    ],
  },
});
