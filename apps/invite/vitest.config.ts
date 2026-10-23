// apps/invite unit tests run in Node: the fragment evaluation, the prompt and the copy. The page
// itself (built site, headers, DOM, Trusted Types, framing) is tested in Chromium by
// e2e/test/invite-page-*.test.ts, because those tests need Node (files, a server) and Playwright.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Repository-wide test timeout policy (M0-10e): 20 s.
    testTimeout: 20_000,
  },
});
