---
'@4thtech-io/types': patch
'@4thtech-io/agentlink': patch
---

ProofStatus names the proof network only under `advanced.chain`: the shared `proofStatusShape` no longer has a top-level `chain`, so real `agentlink_notarize` and `agentlink_get_proof` results match it. A proof that asks for a delivery receipt now says so in a `receiptRequested: true` result field, which the tool output schema lists (M1-33d-d, 06 §2.4).
