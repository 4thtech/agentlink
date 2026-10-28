// Unit tests: the repository-wide 20 s test timeout (M0-10e); DOM tests opt into jsdom with a
// per-file `@vitest-environment` comment.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests that read their stylesheet as text (`?raw`) need it listed here; the default config would replace it with "".
    css: {
      include: [
        /messages\.css/,
        /home\.css/,
        /contacts\.css/,
        /approvals\.css/,
        /activity\.css/,
        /about\.css/,
        /app\.css/,
        /compact\.css/,
      ],
    },
    // Loads the lazy parts once, so tests can render them synchronously (UI-REFRESH-u).
    setupFiles: ['./src/test-setup.ts'],
    testTimeout: 20_000,
  },
});
