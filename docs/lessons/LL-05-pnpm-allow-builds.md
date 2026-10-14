# LL-05 · pnpm 12 ignores `onlyBuiltDependencies`

**Problem.** Allowlisting a dependency's build script with the old `onlyBuiltDependencies` key.

**Symptom.** The install still failed with `ERR_PNPM_IGNORED_BUILDS`.

**Cause.** The pinned pnpm (12.x) no longer reads `onlyBuiltDependencies`; it reads `allowBuilds`. The skeleton also sets `strictDepBuilds: true`, so an unapproved build fails the install instead of being skipped with a warning.

**Rule.** Use `allowBuilds: { <pkg>: true }` in `pnpm-workspace.yaml`, with a justification, and keep `strictDepBuilds: true` and CI's `--ignore-scripts`. Older docs that still say `onlyBuiltDependencies` are stale ([RB-07](../runbooks/add-dependency.md)).

**Source.** IR-M0-2d-1 finding F01 (negative control with `esbuild`); `pnpm-workspace.yaml` on the M0-2d branch.
