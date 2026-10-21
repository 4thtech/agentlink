// apps/submitter tests (M1-10a). The engine and the settings run in Node with an in-memory chain
// (test/engine.test.ts, test/config.test.ts); the Worker runs under Miniflare (workerd) with its
// Durable Objects (test/submitter.test.ts), from test/worker-entry.ts, which swaps each chain's port
// for the same in-memory chain. No Cloudflare account, secret, RPC or network is needed. The real
// chain port (JSON-RPC, ABI, gas-key wallet) is tested in packages/chain.
//
// M1-10c: the deploy smoke steps (test/smoke-steps.ts) run here under Miniflare (test/smoke.test.ts)
// and, in the deploy workflow only, against the deployed staging Worker (test/smoke-remote.test.ts);
// test/smoke-config.test.ts asserts wrangler.toml. The smoke agent signs its Record with the crypto
// test seam `@4thtech-io/crypto/testing` (MemoryKeyStore, a random seed). The seam has no package
// export and is never built: this alias is the only thing that resolves it, and only for tests.
// deps-check and ESLint allow it by that exact name in `apps/submitter/test/**` only
// (tools/deps-check/policy.mjs `testDirs`).
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

const resolve = {
  alias: [
    {
      find: /^@4thtech-io\/crypto\/testing$/,
      replacement: decodeURIComponent(
        new URL('../../packages/crypto/src/testing.ts', import.meta.url).pathname,
      ),
    },
  ],
};

// A fixed, obviously synthetic IP-bucket key (32 bytes of 0x5a, base64url). Production reads a
// Worker secret the owner sets (M1-10c); it is never committed.
const TEST_IP_KEY = 'WlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlo';

export default defineConfig({
  test: {
    projects: [
      {
        resolve,
        test: {
          name: 'node',
          environment: 'node',
          include: [
            'src/**/*.test.ts',
            'test/engine.test.ts',
            'test/config.test.ts',
            'test/smoke-config.test.ts',
          ],
          // Repository-wide test timeout policy (M0-10e): 20 s, not the 5 s default.
          testTimeout: 20_000,
        },
      },
      // M1-10c: the deploy smoke test against a deployed submitter. The deploy workflow sets
      // SUBMITTER_SMOKE_URL (the staging origin); without it the suite is skipped. Plain fetch.
      {
        resolve,
        test: {
          name: 'submitter-smoke-remote',
          environment: 'node',
          include: ['test/smoke-remote.test.ts'],
          provide: { submitterSmokeUrl: process.env.SUBMITTER_SMOKE_URL ?? '' },
          testTimeout: 60_000,
        },
      },
      {
        resolve,
        plugins: [
          cloudflareTest({
            main: './test/worker-entry.ts',
            miniflare: {
              compatibilityDate: '2026-08-01',
              durableObjects: {
                SUBMITTER_QUEUE: 'SubmitterQueue',
                SUBMITTER_LIMITS: 'SubmitterLimits',
                SUBMITTER_FAUCET: 'SubmitterFaucet',
              },
              bindings: {
                SUBMITTER_CHAINS: '84532',
                SUBMITTER_IP_KEY: TEST_IP_KEY,
                SUBMITTER_IP_ITEMS_PER_HOUR: '12',
                SUBMITTER_SIGNER_ITEMS_PER_HOUR: '3',
                SUBMITTER_IP_READS_PER_HOUR: '30',
                SUBMITTER_FAUCET_CHAINS: '84532',
                SUBMITTER_FAUCET_IP_CLAIMS_PER_DAY: '2',
                SUBMITTER_FAUCET_DAILY_CAP: '10',
                SUBMITTER_FAUCET_IP_REQUESTS_PER_HOUR: '20',
              },
            },
          }),
        ],
        test: {
          name: 'submitter',
          include: ['test/submitter.test.ts', 'test/faucet.test.ts', 'test/smoke.test.ts'],
          testTimeout: 20_000,
        },
      },
    ],
  },
});
