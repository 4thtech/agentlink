// apps/submitter tests (M1-10a). The engine and the settings run in Node with an in-memory chain
// (test/engine.test.ts, test/config.test.ts); the Worker runs under Miniflare (workerd) with its
// Durable Objects (test/submitter.test.ts), from test/worker-entry.ts, which swaps each chain's port
// for the same in-memory chain. No Cloudflare account, secret, RPC or network is needed. The real
// chain port (JSON-RPC, ABI, gas-key wallet) is tested in packages/chain.
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// A fixed, obviously synthetic IP-bucket key (32 bytes of 0x5a, base64url). Production reads a
// Worker secret the owner sets (M1-10c); it is never committed.
const TEST_IP_KEY = 'WlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlo';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['src/**/*.test.ts', 'test/engine.test.ts', 'test/config.test.ts'],
          // Repository-wide test timeout policy (M0-10e): 20 s, not the 5 s default.
          testTimeout: 20_000,
        },
      },
      {
        plugins: [
          cloudflareTest({
            main: './test/worker-entry.ts',
            miniflare: {
              compatibilityDate: '2026-08-01',
              durableObjects: {
                SUBMITTER_QUEUE: 'SubmitterQueue',
                SUBMITTER_LIMITS: 'SubmitterLimits',
              },
              bindings: {
                SUBMITTER_CHAINS: '84532',
                SUBMITTER_IP_KEY: TEST_IP_KEY,
                SUBMITTER_IP_ITEMS_PER_HOUR: '12',
                SUBMITTER_SIGNER_ITEMS_PER_HOUR: '3',
              },
            },
          }),
        ],
        test: {
          name: 'submitter',
          include: ['test/submitter.test.ts'],
          testTimeout: 20_000,
        },
      },
    ],
  },
});
