---
section: Changed
---

- Retention defaults made one rule everywhere (CI-823, RET-6/7, S2, 06 §3, 04 §4.2; proposed, owner confirms at merge): the policy defaults keep messages and saved files forever, the same as rules signed before 0.5.2, so changing other rules for the first time never turns on deleting. Only a new ID's first rules (saved files 90 days) or Settings › Storage › Keep automatically set a limit. The owner-action test vectors (version 9) carry the same defaults.
