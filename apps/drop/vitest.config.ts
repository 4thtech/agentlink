// apps/drop tests (M1-27a). Pure helpers run in Node (src/**/*.test.ts); the Worker runs under
// Miniflare (workerd) with an in-memory R2 bucket and its Durable Object (test/**/*.test.ts), with
// test-sized limits so the limit paths run fast. No Cloudflare account, secret or network is needed.
//
// The crypto test seam `@4thtech-io/crypto/testing` (signDropAuthorization; M1-1g-b, 04 §3.1.1) has no
// package export and is never built: this alias is the only thing that resolves it, and only for
// tests. deps-check and ESLint allow it by that exact name in `apps/drop/test/**/*.test.ts` only
// (tools/deps-check/policy.mjs `testDirs`). `@4thtech-io/crypto` maps to the same source, so a test
// sees one copy of the crypto module.
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

const cryptoSource = (file: string): string =>
  decodeURIComponent(new URL(`../../packages/crypto/src/${file}`, import.meta.url).pathname);

const resolve = {
  alias: [
    { find: /^@4thtech-io\/crypto$/, replacement: cryptoSource('index.ts') },
    { find: /^@4thtech-io\/crypto\/testing$/, replacement: cryptoSource('testing.ts') },
  ],
};

const MiB = 1024 * 1024;

// A fixed, obviously synthetic URL key for tests (32 bytes of 0x5a, base64url). Production reads a
// Worker secret that M1-27b provisions; it is never committed.
const TEST_URL_KEY = 'WlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlo';

const testBindings = {
  DROP_URL_KEY: TEST_URL_KEY,
  DROP_CORS_ORIGINS: 'https://console.example',
  DROP_MAX_SIZE: String(8 * MiB),
  DROP_PART_SIZE: String(5 * MiB),
  DROP_WEEKLY_QUOTA: String(20 * MiB),
  DROP_IP_NEW_KEYS_PER_DAY: '3',
  DROP_IP_REQUESTS_PER_HOUR: '8',
};

function workerProject(
  name: string,
  include: string[],
  bindings: Record<string, string>,
  testTimeout = 20_000,
) {
  return {
    plugins: [
      cloudflareTest({
        main: './src/index.ts',
        miniflare: {
          compatibilityDate: '2026-08-01',
          r2Buckets: ['DROP_BUCKET'],
          durableObjects: { DROP_STATE: 'DropState' },
          bindings,
        },
      }),
    ],
    resolve,
    test: {
      name,
      include,
      // Repository-wide test timeout policy (M0-10e): 20 s, not the 5 s default.
      testTimeout,
    },
  };
}

export default defineConfig({
  test: {
    projects: [
      {
        resolve,
        test: {
          name: 'node',
          environment: 'node',
          // M1-27b: the deploy configuration assertions (wrangler.toml, deploy-drop.yml).
          include: ['src/**/*.test.ts', 'test/smoke-config.test.ts'],
          testTimeout: 20_000,
        },
      },
      // M1-27b: the deploy smoke test against a deployed drop. The deploy workflow sets
      // DROP_SMOKE_URL (the staging origin); without it the suite is skipped. Plain fetch, no secrets.
      {
        resolve,
        test: {
          name: 'drop-smoke-remote',
          environment: 'node',
          include: ['test/smoke-remote.test.ts'],
          provide: { dropSmokeUrl: process.env.DROP_SMOKE_URL ?? '' },
          testTimeout: 60_000,
        },
      },
      workerProject('drop', ['test/drop.test.ts'], testBindings),
      // M1-27b: the same smoke steps as the deploy workflow, against the Worker under Miniflare.
      // CHORE-DROP-ENTRY-EXPORTS: the entry module exports only what the Worker runtime expects.
      workerProject('drop-entry', ['test/entry.test.ts'], testBindings),
      workerProject('drop-smoke', ['test/smoke.test.ts'], testBindings),
      workerProject('drop-global-cap', ['test/global-cap.test.ts'], {
        ...testBindings,
        DROP_GLOBAL_BYTES_PER_DAY: String(MiB),
      }),
      // W4-SHORT-INVITE (D-139): invite objects, with the spec's invite limits. The per-IP signed
      // request ceiling is raised so the per-key invite limits are what the tests meet; the invite
      // host origin is a test origin. The 24-hour and live-cap tests take their own longer timeouts.
      workerProject('drop-invite', ['test/invite.test.ts'], {
        ...testBindings,
        DROP_IP_REQUESTS_PER_HOUR: '100000',
        DROP_INVITE_ORIGINS: 'https://invite.example',
      }),
      workerProject('drop-invite-global', ['test/invite-global.test.ts'], {
        ...testBindings,
        DROP_INVITE_FETCHES_PER_HOUR: '40',
      }),
      // The one 5 MiB multipart round trip runs alone. Evidence for its 60 s timeout: on the Linux CI
      // runner a 6 MiB version took 32.6 s in Miniflare's R2 (CI run 39018466636; 1.9 s on macOS),
      // so 20 s is too tight there (IR-M1-27a-1 H-1). The data is already the smallest two-part object.
      workerProject('drop-multipart', ['test/multipart.test.ts'], testBindings, 60_000),
    ],
  },
});
