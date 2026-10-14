// Cross-runtime test run for @agentlink/types (M1-2c; 07 header: Node, browsers, Workers). The same
// test files run in five runtimes: Node, Chromium, Firefox and WebKit (Playwright) and workerd
// (Cloudflare Workers pool, the harness M0-9 uses for the test vectors). Each project provides the
// runtime it expects (`typesRuntime`); src/runtime.test.ts compares that with what the engine
// reports, so a project that silently falls back to Node fails.
//
// Playwright browsers must be installed (`pnpm exec playwright install chromium firefox webkit`);
// `pnpm test:node` runs the Node project alone for a quick local loop.
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

const INCLUDE = ['src/**/*.test.ts'];
// Five runtimes run at once on a small CI runner next to the other packages' tests; the default 5 s
// timed out on the largest envelope test. Same assertions, only more time.
const TIMEOUT = 30_000;

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: INCLUDE,
          testTimeout: TIMEOUT,
          provide: { typesRuntime: 'node' },
        },
      },
      {
        test: {
          name: 'browser',
          include: INCLUDE,
          testTimeout: TIMEOUT,
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            // Failure screenshots would be written next to the tests.
            screenshotFailures: false,
            instances: [
              { browser: 'chromium', provide: { typesRuntime: 'chromium' } },
              { browser: 'firefox', provide: { typesRuntime: 'firefox' } },
              { browser: 'webkit', provide: { typesRuntime: 'webkit' } },
            ],
          },
        },
      },
      {
        plugins: [
          cloudflareTest({
            // workerd forbids code generation from strings (`new Function`, `eval`); zod then runs
            // its non-compiled parsing path, which runtime.test.ts asserts.
            miniflare: {
              compatibilityDate: '2026-08-01',
              compatibilityFlags: ['nodejs_compat'],
            },
          }),
        ],
        test: {
          name: 'workers',
          include: INCLUDE,
          testTimeout: TIMEOUT,
          provide: { typesRuntime: 'workerd' },
        },
      },
    ],
  },
});
