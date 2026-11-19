---
'@4thtech-io/crypto': patch
'@4thtech-io/chain': patch
'@4thtech-io/core': patch
'@4thtech-io/node': patch
---

Proofs: the key store itself now guards proof signing. It signs a proof record only with a single-use ticket issued for exactly that record while its fee is set aside, and its general typed-data signer no longer signs proof records (SEC-KEYSTORE-RECORD-GATE).
