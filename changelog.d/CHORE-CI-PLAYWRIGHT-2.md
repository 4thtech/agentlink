---
section: Fixed
---

- CI no longer waits on apt for the Playwright browsers when the runner already has their libraries (CHORE-CI-PLAYWRIGHT-2): browser downloads come from the version-keyed cache (or the Playwright CDN), and system packages are installed only if a library check finds one missing, with a time limit and one retry.
