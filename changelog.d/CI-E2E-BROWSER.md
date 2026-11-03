---
section: Changed
---

- CI runs the real-browser tests (the app journeys and the browser tests of the node package and the local app) in their own `e2e-browser` job instead of inside `checks`, so their UI waits no longer compete for CPU with every other package's tests. `ci-gate` requires the new job wherever `checks` used to run those tests, and a macOS leg that got no runner is rerun once after a 5-minute wait (CI-E2E-BROWSER, S1).
