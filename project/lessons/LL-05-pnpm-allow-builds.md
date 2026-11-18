# LL-05 · pnpm 11 and later ignore `onlyBuiltDependencies`

**Problem.** Allowlisting a dependency's build script with the old `onlyBuiltDependencies` key.

**Symptom.** The install still failed with `ERR_PNPM_IGNORED_BUILDS`.

**Cause.** pnpm 11 and later (12.x is pinned here) no longer read `onlyBuiltDependencies`; they read `allowBuilds`. The skeleton also sets `strictDepBuilds: true`, so an unapproved build fails the install instead of being skipped with a warning.

**Rule.** Use `allowBuilds: { <pkg>: true }` in `pnpm-workspace.yaml`, with a justification, and keep `strictDepBuilds: true` and CI's `--ignore-scripts`. ([RB-07](../runbooks/add-dependency.md)).

**Source.** IR-M0-2d-1 finding F01 (negative control with `esbuild`); `pnpm-workspace.yaml` on the M0-2d branch.
