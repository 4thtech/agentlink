---
section: Changed
---

- Draft pull requests skip the full CI suite and run it when marked ready for review; non-draft pull requests get a fast `stale-precheck` that merges the current `main` and fails early, with the fix command, on a conflict, drifted generated status files or a stale lockfile. The merge queue still runs everything (CHORE-CI-SPEED-1).
