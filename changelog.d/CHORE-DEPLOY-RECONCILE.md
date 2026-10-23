---
section: Fixed
---

- Production can no longer stay behind main because a commit's CI flaked and the following merges did not touch the submitter or drop (CHORE-DEPLOY-RECONCILE): an hourly reconcile compares what production runs with main's newest commit and, when a deploy-relevant change is missing and that commit's CI is green, starts the normal deploy for it. It does nothing while `DEPLOY_FREEZE` is set, and the started deploy passes every gate as before (green CI, the staging smoke test, the production approval, the head-of-main check).
