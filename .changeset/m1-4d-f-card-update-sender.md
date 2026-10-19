---
'@4thtech-io/core': patch
---

M1-4d-f: the core sends `card-update` itself (04 §2.6, §2.9, §3.4.1; D-102). `client.sendCardUpdates()` (also run by `syncInbox`) sends the current card with `cardSig`, `cardAgentSig` and `cardPop` to every active, paired contact that does not hold it yet and that the owner's `contacts.allowed` permits (D-106; none while the policy fails closed); it is idempotent and resends one the outbox gave up on. The agent keeps its own earlier cards, one per key epoch, in the sealed identity card (no schema change), so `proofSigner(from)` returns the card of the envelope's key epoch for the upcoming `exportProofPack` (M1-7g); a future epoch or an unfinished rotation never gets one. A rotation signs the outgoing card's `cardPop` when it still lacks one. The late `cardPop` write checks its compare-and-set: a lost race is read again, and a race that keeps losing is reported (`key_epoch_mismatch`).
