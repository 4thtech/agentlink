---
section: Changed
---

- Release pull requests (title `RELEASE <version>`) now run the heavy e2e lanes, `e2e-deterministic` and `e2e-browser`, whatever their diff, and the required `ci-gate` fails if either did not pass (CI-HEAVY-ON-RELEASE). Other pull requests keep the fast lane.
