---
section: Changed
---

- CI reruns a flaky failure once by itself (CHORE-CI-AUTORETRY): when a pull request or `main` run of CI or Security fails on its first attempt only in jobs or test steps known to flake (never lint, typecheck or build), its failed jobs are rerun once, so an approved pull request no longer waits for a human rerun.
