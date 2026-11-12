// The docs screenshot generator (`pnpm docs:screens`), kept out of every test run: it writes images
// into docs-site/assets/screens/ and is started only on purpose. Same crypto test seam alias as the
// e2e suites (vitest.config.ts next door).
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const cryptoSource = (file: string): string =>
  decodeURIComponent(new URL(`../../packages/crypto/src/${file}`, import.meta.url).pathname);

export default defineConfig({
  root: fileURLToPath(new URL('..', import.meta.url)),
  resolve: {
    alias: [{ find: /^@4thtech-io\/crypto\/testing$/, replacement: cryptoSource('testing.ts') }],
  },
  test: {
    environment: 'node',
    include: ['docs-screens/**/*.screens.ts'],
    testTimeout: 600_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
