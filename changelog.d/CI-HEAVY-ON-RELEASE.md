---
section: Changed
---

- Release pull requests (title `RELEASE <version>`) now run the heavy e2e lanes, `e2e-deterministic` and `e2e-browser`, whatever their diff, and the required `ci-gate` fails if either did not pass (CI-HEAVY-ON-RELEASE). Other pull requests keep the fast lane. Renaming a PR to `RELEASE` does not rerun CI: open release PRs with that title (`tools/pr/open-pr.mjs`) or from a `rel*/release` branch, and after a rename push a commit or rerun the workflow.
