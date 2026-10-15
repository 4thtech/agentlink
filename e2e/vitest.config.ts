// e2e suites in Node (M1-13). The crypto test seam `@agentlink/crypto/testing` (MemoryOwnerKeyStore,
// the test owner; 04 §3.1.1 allows it in e2e, tools/deps-check/policy.mjs zone `e2e`) has no package
// export and is never built: this alias is the only thing that resolves it. Only the seam is
// aliased: `@agentlink/crypto` stays the built entry.
import { defineConfig } from 'vitest/config';

const cryptoSource = (file: string): string =>
  decodeURIComponent(new URL(`../packages/crypto/src/${file}`, import.meta.url).pathname);

export default defineConfig({
  resolve: {
    alias: [{ find: /^@agentlink\/crypto\/testing$/, replacement: cryptoSource('testing.ts') }],
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'llm/**/*.test.ts'],
    // Repository-wide test timeout policy (M0-10e): 20 s; the scenarios set their own, longer ones.
    testTimeout: 20_000,
    // One scenario at a time: the suites share the OS keychain and Docker.
    fileParallelism: false,
  },
});
