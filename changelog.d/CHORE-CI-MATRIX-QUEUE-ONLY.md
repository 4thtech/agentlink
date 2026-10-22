---
section: Changed
---

- CI spends fewer runner minutes (CHORE-CI-MATRIX-QUEUE-ONLY, S1): the macOS and Windows jobs run only in the merge queue and on `main`, and a docs-only change skips the heavy test, vector, e2e and matrix jobs. Required checks and the merge queue gate are unchanged.
