// Unit tests in Node. Repository-wide test timeout policy (M0-10e): 20 s per test instead of the
// 5 s Vitest default, which flakes on loaded CI runners (docs/process/repo-reference.md, Testing
// expectations). Every packages/* config sets the same value; a longer limit is never lowered.
//
// Two projects (M1-6b part 2, IR-M1-6b-2-2 M-3): the storage integration test runs in workers
// started with --expose-gc, so its 1 GiB memory gate can measure what is still held after a forced
// collection, in CI as well as locally. Every other test runs without it.
//
// M1-6c: a third project runs the drop adapter against the real drop Worker (apps/drop, M1-27a)
// under Miniflare (workerd), as apps/drop's own tests do, with test-sized limits. The crypto test
// seam `@4thtech-io/crypto/testing` (signDropAuthorization, signing with a fixed test drop key in
// place of the KeyStore) has no package export and is never built: the alias below is the only
// thing that resolves it, and only for that project. deps-check and ESLint allow it by that exact
// name in this package's *.test.ts files only (tools/deps-check/policy.mjs). `@4thtech-io/crypto`
// maps to the same source, so the test sees one copy of the crypto module.
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

const INTEGRATION = 'src/integration.test.ts';
const DROP_WORKER = 'src/drop.worker.test.ts';
const MiB = 1024 * 1024;

const cryptoSource = (file: string): string =>
  decodeURIComponent(new URL(`../crypto/src/${file}`, import.meta.url).pathname);
const dropWorker = decodeURIComponent(
  new URL('../../apps/drop/src/index.ts', import.meta.url).pathname,
);

export default defineConfig({
  test: {
    testTimeout: 20_000,
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          exclude: [INTEGRATION, DROP_WORKER],
          testTimeout: 20_000,
        },
      },
      {
        test: {
          name: 'integration',
          include: [INTEGRATION],
          testTimeout: 20_000,
          execArgv: ['--expose-gc'],
        },
      },
      {
        plugins: [
          cloudflareTest({
            main: dropWorker,
            miniflare: {
              compatibilityDate: '2026-08-01',
              r2Buckets: ['DROP_BUCKET'],
              durableObjects: { DROP_STATE: 'DropState' },
              bindings: {
                // A fixed, obviously synthetic URL key (32 bytes of 0x5a), as in apps/drop's tests.
                DROP_URL_KEY: 'WlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlo',
                DROP_MAX_SIZE: String(8 * MiB),
                DROP_PART_SIZE: String(5 * MiB),
                DROP_WEEKLY_QUOTA: String(24 * MiB),
                DROP_IP_NEW_KEYS_PER_DAY: '1000',
              },
            },
          }),
        ],
        resolve: {
          alias: [
            { find: /^@4thtech-io\/crypto$/, replacement: cryptoSource('index.ts') },
            { find: /^@4thtech-io\/crypto\/testing$/, replacement: cryptoSource('testing.ts') },
          ],
        },
        test: {
          name: 'drop-worker',
          include: [DROP_WORKER],
          // Repository-wide test timeout policy (M0-10e): 20 s; the large round trips set their own.
          testTimeout: 20_000,
        },
      },
    ],
  },
});
