---
section: Fixed
---

- A submitter or drop deploy run that skips production because a newer commit landed on main no longer ends silently green (CHORE-DEPLOY-CATCHUP): it warns and its run summary names the newer commit and the run that deploys it. The catch-up run also starts after a commit's CI fails (for example a flaky test) and no longer counts a failed run as covering main's newest commit, so production follows the newest green commit instead of stalling. Every production gate (the commit's own green CI, the staging smoke test, the production approval, `DEPLOY_FREEZE`) is unchanged.
