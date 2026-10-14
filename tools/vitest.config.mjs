import { defineConfig } from 'vitest/config';

// Tools tests lint or scan the whole repository, and the work grows with every package that adds
// code or tests. Measured (M0-10d): warm tests take under 0.5 s locally and about 1.8 s with the
// CPU oversubscribed twofold (crypto and types tests running in parallel); the slowest, the
// ESLint cold start and the policy repo scan, took more than 5 s on CI runners. 20 s is about
// 10x the loaded local worst case. Cold starts are moved into beforeAll; hookTimeout covers them.
export default defineConfig({
  test: {
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
