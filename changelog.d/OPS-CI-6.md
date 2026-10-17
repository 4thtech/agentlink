---
section: Changed
---

- The deterministic e2e suite is now part of the merge gate (OPS-CI-6, S1, process): `ci.yml` calls it and `ci-gate` requires it, in pull requests and in the merge queue; docs-only changes skip it.
