---
'@4thtech-io/core': patch
---

Proofs (M1-7g-c, 04 §3.4): a received `proof` body that does not match the on-chain record (`proof_mismatch`, or `proof_parent_mismatch` for another signer's parent) now flags the contact: the `proof` envelope is stored as refused with that fixed code, and `syncInbox` and the live subscription report it as a flagged refusal. `ProofService.processInbound` returns `{signed, reports}` (`ProofInboundResult`) instead of a number. One contact holds at most `PROOF_PENDING_PER_CONTACT` (32) of the 256 bodies pending a chain read.
