---
'@4thtech-io/agentlink': patch
---

`agentlink_propose_terms` and `agentlink_respond_to_terms` claim free test credits once on the first `needs_credits` with a testnet route, as `agentlink_notarize` and `agentlink_send` do, and tell the agent to call the same tool again in about a minute; when free test credits are paused they say so (M1-36i-d).
