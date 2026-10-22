---
'@4thtech-io/chain': patch
---

The chain-state `getRecord` treats a returned record with a zero signer as a bad chain answer (`bad_answer`, retryable), never as "no record". Only the Notary's `RecordNotFound()` revert means absent, so a misbehaving RPC can no longer make the client sign a replacement or send a record twice.
