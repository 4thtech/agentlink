---
'@4thtech-io/core': patch
---

M1-7g: notarize, receipts and the proof-pack export in the core. `notarize` records a sent envelope (kind from the payload, automatic chain selection, policy and daily budget, approvals) and delivers the salt in a `proof` envelope; the recipient checks the record on-chain before any receipt, signs DELIVERED per policy and the deferred ACCEPTED of an approved accept; `acknowledge`, `getProof` and `proofs.exportProofPack` (key disclosure only with an owner approval). New client option `proofs`.
