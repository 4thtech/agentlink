---
section: Fixed
---

- CI's "Install Playwright browsers" step no longer runs into its 12-minute limit when the Ubuntu mirror is slow (CHORE-CI-PLAYWRIGHT-3): WebKit's system packages now come from a cache (each file checked against apt's signed index before apt uses it), every network sub-step shares one time budget inside the limit, and only a push to `main` saves the caches.
