import { defineConfig } from 'vitest/config';

// Vitest workspace: one project per package. `pnpm test` runs each package's own `vitest run`
// through Turborepo (so builds of dependencies come first); this root config lets `pnpm exec
// vitest` run or watch everything at once, and lets editors discover every project.
export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*', 'tools'],
  },
});
