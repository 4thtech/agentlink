// The prompt-injection suites (M1-13b, M1-13d), run on their own:
//
//   pnpm --filter @4thtech-io/e2e exec vitest run --config prompt-injection/vitest.config.ts
//
// The deterministic layer (deterministic/*.test.ts) needs only the built CLI and packages (no
// Docker, no keychain, no secret) and always runs. The LLM observational run (llm/*.test.ts) is
// opt-in and skipped without AGENTLINK_E2E_LLM=1 and its API key (see that file).
//
// As in ../vitest.config.ts: the crypto test seam `@4thtech-io/crypto/testing` has no package
// export and is resolved from source (04 §3.1.1 allows it in e2e).
import { defineConfig } from 'vitest/config';

const repo = (file: string): string =>
  decodeURIComponent(new URL(`../../${file}`, import.meta.url).pathname);

export default defineConfig({
  root: decodeURIComponent(new URL('.', import.meta.url).pathname),
  resolve: {
    alias: [
      {
        find: /^@4thtech-io\/crypto\/testing$/,
        replacement: repo('packages/crypto/src/testing.ts'),
      },
    ],
  },
  test: {
    environment: 'node',
    include: ['deterministic/**/*.test.ts', 'llm/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
