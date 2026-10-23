// Unit tests: the repository-wide 20 s test timeout (M0-10e); DOM tests opt into jsdom with a
// per-file `@vitest-environment` comment.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 20_000,
  },
});
