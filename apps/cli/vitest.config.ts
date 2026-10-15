// apps/cli tests in Node. The crypto test seam `@agentlink/crypto/testing` (MemoryOwnerKeyStore;
// M1-1g-b, 04 §3.1.1) has no package export and is never built: this alias is the only thing that
// resolves it, and only for tests. deps-check and ESLint allow it by that exact name in
// `apps/cli/test/**/*.test.ts` only, never in `src/` (tools/deps-check/policy.mjs `testDirs`,
// IR-M1-9k-1 F01). Only the seam is aliased: `@agentlink/crypto` stays the built entry.
import { defineConfig } from 'vitest/config';

const cryptoSource = (file: string): string =>
  decodeURIComponent(new URL(`../../packages/crypto/src/${file}`, import.meta.url).pathname);

export default defineConfig({
  resolve: {
    alias: [{ find: /^@agentlink\/crypto\/testing$/, replacement: cryptoSource('testing.ts') }],
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // Repository-wide test timeout policy (M0-10e): 20 s, not the 5 s default.
    testTimeout: 20_000,
  },
});
