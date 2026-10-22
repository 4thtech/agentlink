---
section: Fixed
---

- An approved accept or `confirm` now reports what happened to its receipt in that call: `recorded` once it is on-chain, `submitted` once signed but not landed, `waiting_for_record` only while the record has not arrived (M1-7g-f, S2, 06 §2.2a). Before, it said `waiting_for_record` even after signing.
- A `proof` envelope waiting for its message whose envelope was refused releases its place in the waiting pool at once instead of holding it for 7 days; 04 §3.4 now names the per-contact share of both proof pools (M1-7g-f, S2, 04 §3.4; proposed, owner confirms at merge).
