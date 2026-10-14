# LL-06 · A root `vitest.config.ts` leaks into every package

**Problem.** A root Vitest file with a `projects` list was named `vitest.config.ts`.

**Symptom.** Running `vitest` inside a package applied the root `projects` list there too.

**Cause.** Vitest 4 looks for its config upwards from the working directory, so a package without its own config finds the root one.

**Rule.** The root file is named `vitest.workspace.ts` and is passed explicitly (`pnpm exec vitest --config vitest.workspace.ts`). Each package runs its own `vitest run`.

**Source.** M0-2d (PR #2); comment in `vitest.workspace.ts`.
