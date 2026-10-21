---
section: Fixed
---

- Deploys and releases no longer fail when a newer merge supersedes a commit's CI before it runs (CHORE-CI-SUPERSEDED): the run ends as skipped with a notice, and the submitter and drop deploys start a catch-up run for the newest commit on main, which still needs its own green CI, the staging smoke test and every production gate.
