---
section: Fixed
---

- A release or deploy no longer stays undone when the heavy CI on `main` is slow or flaky (OPS-CIGREEN-WAIT, S2, CI): the deploys now wait up to 90 minutes for this commit's CI, as the release does, and a new `ci-green pick-up` workflow re-runs the failed jobs of the release and deploy runs of a commit whose `ci-green` gave up, as soon as that commit's CI and Security turn green and it is still the head of `main`. The re-run is the original run, so every check, approval and freeze applies unchanged; anything it cannot pick up shows as a red run.
