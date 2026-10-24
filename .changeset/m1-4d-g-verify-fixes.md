---
'@4thtech-io/chain': patch
---

The proof-pack verifier reads a `getRecord` revert as "no such record" only when its data is exactly the `RecordNotFound()` selector, as the submitter port does; revert data with trailing bytes stays `chain_unavailable`. A returned record with a zero signer is now `malformed_record` instead of `record_not_found`, and no other block is read for it. `ChainError` gains `revertBare` (true when the revert data was exactly a 4-byte selector).
