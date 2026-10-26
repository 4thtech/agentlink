// Unit tests in Node. The crypto test seam `@4thtech-io/crypto/testing` (MemoryKeyStore,
// MemoryOwnerKeyStore and the deterministic helpers; M1-1g-b, 04 §3.1.1) has no package export and is
// never built: this alias is the only thing that resolves it, and only for tests. deps-check and
// ESLint allow it by that exact name in this package's *.test.ts files only (tools/deps-check/policy.mjs).
//
// `@4thtech-io/crypto` maps to the same source, so a test sees one copy of the crypto module (one
// CryptoInputError, one KeyStoreError) whether a value comes from the seam or the main entry. The
// entries are anchored: `@4thtech-io/crypto/keystore` is not mapped (and stays refused here).
//
// M2-3t-w: a second project, `workerd`, runs the *.workerd.test.ts files in the Cloudflare Workers
// runtime (Miniflare), because the cloud agent (M2-3a) runs this package in a user's Worker. Those
// files are excluded from the Node project: they assert the runtime they run in.
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

const WORKERD = 'src/**/*.workerd.test.ts';

const cryptoSource = (file: string): string =>
  decodeURIComponent(new URL(`../crypto/src/${file}`, import.meta.url).pathname);
const alias = [
  { find: /^@4thtech-io\/crypto$/, replacement: cryptoSource('index.ts') },
  { find: /^@4thtech-io\/crypto\/testing$/, replacement: cryptoSource('testing.ts') },
];

export default defineConfig({
  test: {
    // Repository-wide test timeout policy (M0-10e): 20 s, not the 5 s default (docs/process/repo-reference.md).
    testTimeout: 20_000,
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit',
          environment: 'node',
          // Only *.test.ts: the one test-file name every build excludes (IR-M1-1c-G2-1 L-1).
          include: ['src/**/*.test.ts'],
          exclude: [WORKERD, 'node_modules/**'],
          testTimeout: 20_000,
        },
      },
      {
        resolve: { alias },
        // No nodejs_compat flag: the package must work with the Workers runtime alone.
        plugins: [cloudflareTest({ miniflare: { compatibilityDate: '2026-08-01' } })],
        test: { name: 'workerd', include: [WORKERD], testTimeout: 20_000 },
      },
    ],
  },
});
