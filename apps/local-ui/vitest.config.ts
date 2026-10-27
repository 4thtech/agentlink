// Unit tests: the repository-wide 20 s test timeout (M0-10e); DOM tests opt into jsdom with a
// per-file `@vitest-environment` comment.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // messages.test.ts, home.test.ts, contacts-refresh.test.ts and activity.refresh.test.ts read their stylesheet as text (`?raw`); the default config would replace it with "".
    css: { include: [/messages\.css/, /home\.css/, /contacts\.css/, /activity\.css/] },
    testTimeout: 20_000,
  },
});
