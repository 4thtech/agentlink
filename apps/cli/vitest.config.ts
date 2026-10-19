// apps/cli tests in Node. The crypto test seam `@4thtech-io/crypto/testing` (MemoryOwnerKeyStore;
// M1-1g-b, 04 §3.1.1) has no package export and is never built: this alias is the only thing that
// resolves it, and only for tests. deps-check and ESLint allow it by that exact name in
// `apps/cli/test/**/*.test.ts` only, never in `src/` (tools/deps-check/policy.mjs `testDirs`,
// IR-M1-9k-1 F01). Only the seam is aliased: `@4thtech-io/crypto` stays the built entry.
//
// M1-9d-1: a second project runs the file tools end to end through the real drop Worker (apps/drop,
// M1-27a) under Miniflare (workerd), with the test-sized limits of packages/core's `drop-worker`
// project. Only `test/**/*.worker.test.ts` runs there: the MCP server and the handlers (src/tools,
// runtime-agnostic, 06 §1) over two in-memory cores; nothing from src/runtime or @4thtech-io/node.
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

const DROP_WORKER = 'test/**/*.worker.test.ts';
const MiB = 1024 * 1024;

const cryptoSource = (file: string): string =>
  decodeURIComponent(new URL(`../../packages/crypto/src/${file}`, import.meta.url).pathname);
const dropWorker = decodeURIComponent(new URL('../drop/src/index.ts', import.meta.url).pathname);
const alias = [{ find: /^@4thtech-io\/crypto\/testing$/, replacement: cryptoSource('testing.ts') }];

export default defineConfig({
  test: {
    // Repository-wide test timeout policy (M0-10e): 20 s, not the 5 s default.
    testTimeout: 20_000,
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'node',
          environment: 'node',
          include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
          exclude: [DROP_WORKER],
          testTimeout: 20_000,
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
        // In workerd the seam and the main entry must be one copy of the crypto module (one
        // KeyStoreError), as in packages/core's `drop-worker` project.
        resolve: {
          alias: [
            ...alias,
            { find: /^@4thtech-io\/crypto$/, replacement: cryptoSource('index.ts') },
          ],
        },
        test: {
          name: 'drop-worker',
          include: [DROP_WORKER],
          testTimeout: 20_000,
        },
      },
    ],
  },
});
