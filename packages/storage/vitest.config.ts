// Unit tests in Node. Repository-wide test timeout policy (M0-10e): 20 s per test instead of the
// 5 s Vitest default, which flakes on loaded CI runners (docs/process/repo-reference.md, Testing
// expectations). Every packages/* config sets the same value; a longer limit is never lowered.
//
// Two projects (M1-6b part 2, IR-M1-6b-2-2 M-3): the storage integration test runs in workers
// started with --expose-gc, so its 1 GiB memory gate can measure what is still held after a forced
// collection, in CI as well as locally. The unit project runs with it too, for the gate's negative
// control (memory-gate.test.ts, IR-CI-memgate-1 H-1), which runs on every CI without MinIO.
import { defineConfig } from 'vitest/config';

const INTEGRATION = 'src/integration.test.ts';

export default defineConfig({
  test: {
    testTimeout: 20_000,
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          exclude: [INTEGRATION],
          testTimeout: 20_000,
          execArgv: ['--expose-gc'],
        },
      },
      {
        test: {
          name: 'integration',
          include: [INTEGRATION],
          testTimeout: 20_000,
          execArgv: ['--expose-gc'],
        },
      },
    ],
  },
});
