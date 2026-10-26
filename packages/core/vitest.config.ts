// Unit tests in Node. The crypto test seam `@4thtech-io/crypto/testing` (MemoryKeyStore,
// MemoryOwnerKeyStore and the deterministic helpers; M1-1g-b, 04 §3.1.1) has no package export and is
// never built: this alias is the only thing that resolves it, and only for tests. deps-check and
// ESLint allow it by that exact name in this package's *.test.ts files only (tools/deps-check/policy.mjs).
//
// `@4thtech-io/crypto` maps to the same source, so a test sees one copy of the crypto module (one
// CryptoInputError, one KeyStoreError) whether a value comes from the seam or the main entry. The
// entries are anchored: `@4thtech-io/crypto/keystore` is not mapped (and stays refused here).
//
// M1-7f: a second project runs the files round trip through the real drop Worker (apps/drop, M1-27a)
// under Miniflare (workerd), with the test-sized limits of packages/storage's `drop-worker` project.
// Repository-wide test timeout policy (M0-10e): 20 s, not the 5 s default (docs/process/repo-reference.md).
//
// M1-7f-3: a third project runs the files round trip against real own S3 storage (MinIO) in CI's
// `storage-minio` job; without AGENTLINK_STORAGE_IT its suite is skipped (files/minio.integration.test.ts).
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

const DROP_WORKER = 'src/**/*.worker.test.ts';
const INTEGRATION = 'src/**/*.integration.test.ts';
const MiB = 1024 * 1024;

const cryptoSource = (file: string): string =>
  decodeURIComponent(new URL(`../crypto/src/${file}`, import.meta.url).pathname);
const dropWorker = decodeURIComponent(
  new URL('../../apps/drop/src/index.ts', import.meta.url).pathname,
);
const alias = [
  { find: /^@4thtech-io\/crypto$/, replacement: cryptoSource('index.ts') },
  { find: /^@4thtech-io\/crypto\/testing$/, replacement: cryptoSource('testing.ts') },
];

export default defineConfig({
  test: {
    testTimeout: 20_000,
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit',
          environment: 'node',
          // Only *.test.ts: the one test-file name every build excludes (IR-M1-1c-G2-1 L-1).
          include: ['src/**/*.test.ts'],
          exclude: [DROP_WORKER, INTEGRATION],
          testTimeout: 20_000,
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'integration',
          environment: 'node',
          include: [INTEGRATION],
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
        resolve: { alias },
        test: {
          name: 'drop-worker',
          include: [DROP_WORKER],
          testTimeout: 20_000,
        },
      },
    ],
  },
});
