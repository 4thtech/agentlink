// Unit tests in Node. Repository-wide test timeout policy (M0-10e): 20 s per test instead of the
// 5 s Vitest default, which flakes on loaded CI runners (docs/process/repo-reference.md, Testing
// expectations). Every packages/* config sets the same value; a longer limit is never lowered.
//
// M2-3t-w: a second project, `workerd`, runs the *.workerd.test.ts files in the Cloudflare Workers
// runtime (Miniflare), because the cloud agent (M2-3a) runs this package in a user's Worker. Those
// files are excluded from the Node project: they assert the runtime they run in.
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

const WORKERD = 'src/**/*.workerd.test.ts';

export default defineConfig({
  test: {
    testTimeout: 20_000,
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          exclude: [WORKERD, 'node_modules/**'],
          testTimeout: 20_000,
        },
      },
      {
        // No nodejs_compat flag: the package must work with the Workers runtime alone.
        plugins: [cloudflareTest({ miniflare: { compatibilityDate: '2026-08-01' } })],
        test: { name: 'workerd', include: [WORKERD], testTimeout: 20_000 },
      },
    ],
  },
});
