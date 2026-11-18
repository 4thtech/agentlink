// The hostile-peer and hostile-relay suites (E2E-HOSTILE), run on their own:
//
//   pnpm --filter @4thtech-io/e2e exec vitest run --config hostile/vitest.config.ts
//
// They need only the built CLI and packages: no Docker, no OS keychain, no network, no secret. As in
// ../vitest.config.ts the crypto test seam `@4thtech-io/crypto/testing` has no package export and is
// resolved from source (04 §3.1.1 allows it in e2e).
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
    include: ['*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
