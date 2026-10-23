---
'@4thtech-io/types': patch
'@4thtech-io/agentlink': patch
---

The shared ProofStatus shape now matches real `agentlink_notarize` and `agentlink_get_proof` results and 06 §2.4 (M1-33d-d): the proof network only under `advanced.chain` (no top-level `chain`); `txHash` and the fee split optional on every status; `agentAddress` and `topUpUrl` allowed on `needs_credits` only; `explorerUrl` and `verifyUrl` removed. A proof that asks for a delivery receipt now says so in a `receiptRequested: true` result field, which the tool output schema lists.
