// Unit tests in Node. Repository-wide test timeout policy (M0-10e): 20 s, not the 5 s default.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 20_000,
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
  },
});
