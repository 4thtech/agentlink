---
'@4thtech-io/types': patch
'@4thtech-io/core': patch
---

M1-7g-b (D-107): recipient-side proof-pack export. `@4thtech-io/types`: the strict `proof` body schema accepts the signed `record` (05 §3.1 JSON form) and its `signature` (1 to 4 096 bytes), present together or not at all. `@4thtech-io/core`: every `proof` body the core sends carries the signed Record and signature; the recipient runs the 04 §3.4 receive checks 1–5 before storing them (a mismatch drops the whole body, `proof_mismatch`), keeps a body whose chain read failed pending and checks it again at later syncs (at most 256 bodies, 7 days, then `proof_unchecked`), and `exportProofPack` builds the recipient's own pack (recipient and salt only with `includeRecipient`; `RECORD_UNAVAILABLE` for an older sender's body). `ProofKit` now also takes `computeRecordId` and `verifyProofPack` from `@4thtech-io/chain`.
