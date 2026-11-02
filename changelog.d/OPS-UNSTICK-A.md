---
section: Changed
---

- Releases and deploys no longer get stuck (OPS-UNSTICK-A, process): a service deploys to production unless a newer merge changes that service, a deploy run that was cancelled or superseded hands off to the run that deploys (and turns red when none will), review checks no longer cancel each other, a release overtaken by another merge is still published, the broken automatic `next` snapshot from `main` is switched off, and known flaky tests sit in a visible quarantine that expires after at most 14 days.
