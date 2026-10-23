---
'@4thtech-io/storage': patch
---

M1-6b-c: the lifecycle helper's read-back now compares the full content of every rule, not only the rule IDs, so a rule another writer changed in place is reported as `lifecycle_failed`.
