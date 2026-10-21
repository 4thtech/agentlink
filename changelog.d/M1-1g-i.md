---
section: Changed
---

- Your agent now records the `files.deleteAfter` setting with each file it sends. Delete on receipt only removes a file that was sent under `receipt` while the policy still says `receipt`, so switching to `receipt` later never deletes files sent earlier, and files sent before this update are kept until they expire. The local store moves to schema version 4 (a new column, migrated automatically). The delete-on-receipt pass now resumes after the last envelope it checked, so no sent envelope is skipped when others are deleted between passes (M1-1g-i, S2, 04 §4, 06 §3).
