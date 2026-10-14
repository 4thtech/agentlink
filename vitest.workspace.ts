import { defineConfig } from 'vitest/config';

// Vitest workspace: one project per package. `pnpm test` runs each package's own `vitest run`
// through Turborepo (so builds of dependencies come first). To run or watch everything at once
// after a build, use `pnpm exec vitest --config vitest.workspace.ts`.
//
// The file is deliberately not called vitest.config.ts: Vitest 4 finds a config in a parent
// directory, and a root file with `projects` would then be applied inside every package.
export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*', 'tools'],
  },
});
