// Unit tests in Node. Repository-wide test timeout policy (M0-10e): 20 s, not the 5 s default.
//
// M2-3t-w: a second project, `workerd`, runs the *.workerd.test.ts files in the Cloudflare Workers
// runtime (Miniflare), because the remote MCP server (M2-3b) runs these handlers in a Worker. Those
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
          testTimeout: 20_000,
          include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
          exclude: [WORKERD, 'node_modules/**'],
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
