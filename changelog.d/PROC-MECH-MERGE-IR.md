---
section: Changed
---

- A moved PR head that is only a mechanical merge of `main` (empty remerge-diff, identical own diff, green CI) now needs only a lightweight check, recorded `IR-<ID>-<n>: PASS (mechanical)`; any hand conflict resolution still needs a full independent review (PROC-MECH-MERGE-IR, D-126).
