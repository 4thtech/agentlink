// apps/cloud-agent tests (M2-3a). The Worker and AgentDO run under Miniflare (workerd) with a
// SQLite-backed Durable Object and an in-memory R2 bucket; relays are an in-memory relay behind the
// RelayConnector seam (test/worker.ts). No Cloudflare account, secret or network is needed. The
// wrangler.toml assertions run in Node.
//
// The crypto test seam `@4thtech-io/crypto/testing` (MemoryOwnerKeyStore, MemoryKeyStore; M1-1g-b)
// has no package export and is never built: this alias is the only thing that resolves it, and only
// for tests. deps-check and ESLint allow it by that exact name in `apps/cloud-agent/test/**/*.test.ts`
// only (tools/deps-check/policy.mjs `testDirs`). `@4thtech-io/crypto` and its `/keystore` entry map
// to the same source, so a test sees one copy of the crypto module.
//
// Repository-wide test timeout policy (M0-10e): 20 s, not the 5 s default.
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { TEST_AGENT_SEED, TEST_SEED_WRAP_KEY } from './test/secrets.js';

const cryptoSource = (file: string): string =>
  decodeURIComponent(new URL(`../../packages/crypto/src/${file}`, import.meta.url).pathname);

const resolve = {
  alias: [
    { find: /^@4thtech-io\/crypto$/, replacement: cryptoSource('index.ts') },
    { find: /^@4thtech-io\/crypto\/keystore$/, replacement: cryptoSource('keystore.ts') },
    { find: /^@4thtech-io\/crypto\/testing$/, replacement: cryptoSource('testing.ts') },
  ],
};

function workerProject(name: string, include: string[], bindings: Record<string, string>) {
  return {
    plugins: [
      cloudflareTest({
        main: './test/worker.ts',
        miniflare: {
          compatibilityDate: '2026-08-01',
          r2Buckets: ['FILES'],
          durableObjects: { AGENT: { className: 'TestAgentDO', useSQLite: true } },
          bindings,
        },
      }),
    ],
    resolve,
    test: { name, include, testTimeout: 20_000 },
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
          include: ['test/config.test.ts'],
          testTimeout: 20_000,
        },
      },
      workerProject(
        'cloud-agent',
        ['test/agent.test.ts', 'test/store.test.ts', 'test/keystore.test.ts', 'test/relay.test.ts'],
        { AGENT_SEED: TEST_AGENT_SEED },
      ),
      workerProject('cloud-agent-sealed', ['test/sealed-seed.test.ts'], {
        SEED_WRAP_KEY: TEST_SEED_WRAP_KEY,
      }),
    ],
  },
});
