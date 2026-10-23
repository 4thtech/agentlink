---
'@4thtech-io/agentlink': patch
---

`agentlink_propose_terms` and `agentlink_respond_to_terms` return the top-up link on `needs_credits` as structured `topUpUrl` and `agentAddress` fields, in the same form as `agentlink_send` and `agentlink_notarize` (D-113 link), not only inside `nextStep`; neither field is set while adding credits is not available (M1-9d-4).
