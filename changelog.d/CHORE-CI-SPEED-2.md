---
section: Changed
---

- Pull requests get CI results faster (CHORE-CI-SPEED-2, S1): the `checks` job of a pull request lints, typechecks, builds and tests only the packages it changes, the packages that depend on them, and the packages whose tests read a changed doc (`tools/ci/select-affected.mjs`). A change to root config, the lockfile, `tools/`, `.github/`, `test-vectors/` or the shared packages `types`, `crypto` and `core` still runs everything, and the merge queue and `main` always run the full suite.
