---
'@4thtech-io/core': patch
'@4thtech-io/transport-nostr': patch
'@4thtech-io/agentlink': patch
---

Live relay subscriptions (M1-9s): `Transport.subscribe` and `AgentLinkClient.subscribeInbox` in the core; the MCP server's background loop receives new messages and handshakes as they reach a relay, with a 5-minute fallback catch-up, and closes the subscription on lease loss and on shutdown.
