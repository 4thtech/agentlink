// apps/desktop unit tests (WP-D2): every main-process module takes Electron by injection
// (src/main/electron-api.ts), so the lockdown runs in plain Node with fakes; no Electron binary.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'desktop',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Repository-wide test timeout policy (M0-10e): 20 s, not the 5 s default.
    testTimeout: 20_000,
  },
});
