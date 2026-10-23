---
'@4thtech-io/core': minor
---

Read-only accessors for the local UI (M1-11r-a): `identity.fingerprints()`, `identity.agentAddress()` and `identity.relays()`; `client.files.resolvedFolders()`; `proofs.list({cursor, limit})`, `proofs.creditsBalance()` and `proofs.requestFaucet(chainId)` (allowlisted testnets only, through the new optional `ProofsPlatform.faucet` port); and `client.activity.list({cursor, limit})`, a newest-first feed of decided approvals, proofs, blocks and the rules in force. Public values only; no new storage. `ProofKit` now also picks `readCreditsAcrossChains` and `isFaucetChain` (pass `@4thtech-io/chain` itself, as before).
