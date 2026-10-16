---
'@agentlink/core': patch
---

Add `AgentLinkClient.close()` and an optional `Transport.close()` that close the relay connections of a client, so one-shot callers can end their process.
