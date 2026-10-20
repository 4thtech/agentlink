---
'@4thtech-io/agentlink': patch
---

M1-26-b: tool results name no proof network outside Advanced (D-40, 11 §5.1). The ProofStatus of `agentlink_notarize`, `agentlink_get_proof`, the `proof` of `agentlink_send` and the terms tools, and `agentlink_verify_proof_pack` carry the network as `advanced.chain` instead of a top-level `chain`; `agentlink_status` `credits` entries are `{usd, advanced: {chain, token, amount}}`. A proof pack now verifies against every shipped chain with no chain configured, including one automatic selection holds back.

The moved fields were never in a released version, so this is not a breaking change for any released user.
