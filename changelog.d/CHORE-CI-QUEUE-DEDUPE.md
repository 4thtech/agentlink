---
section: Changed
---

- The merge queue stops running CI twice per entry (CHORE-CI-QUEUE-DEDUPE, sensitive): `ci.yml` and the branch secret scan now ignore pushes to `gh-readonly-queue/**` branches, because the `merge_group` run already covers the same commit. The required checks are still produced by the `merge_group` runs; pushes to `main` and to ordinary branches are unchanged.
