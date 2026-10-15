---
'@agentlink/core': minor
---

Add the terms flow and one approval per agreement (M1-32, D-55). `client.proposeTerms` and `client.respondToTerms` (`accept`, `reject`, `counter`) fill the chain fields from the agent's own store and copy the stored terms into answers. The 04 §3.4 negotiation chain runs on receive (new inbound reason `terms_refused`) and is rebuilt from the stored envelopes. An `accept` builds one `CommitmentScope`, is decided by `evaluateCommitment` (owner request or policy grant; nothing is sent or stored on deny), and runs each part at most once under an atomic claim, with void rules 1–6 checked before each part. `client.terms` exposes the commitment card data, the negotiations, `deferredReceipt` and `claimReceiptPartTx` (for M1-7g), and `expireDue`. `ApprovalService.request` takes an optional `commitment` (scope key and parts). `notarize` returns `NOTARIZE_UNAVAILABLE` until the proof flow lands.
