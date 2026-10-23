---
section: Changed
---

- Pull requests start fewer CI jobs (CHORE-CI-SPEED-3, S1): the heavy jobs `vectors`, `keychain`, `relays-docker`, `storage-minio`, `bundle-check` and `e2e-deterministic` run on a pull request only when its change reaches the packages they test (`HEAVY_JOBS` in `tools/ci/select-affected.mjs`). A change to `.github/`, `tools/`, root config, the lockfile, an unknown path or the shared packages runs them all. The merge queue and `main` always run every job, and in the queue `ci-gate` now fails if one of them did not run and pass.
