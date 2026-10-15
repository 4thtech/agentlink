---
'@4thtech/agentlink': minor
---

While `agentlink mcp` runs, it now keeps receiving and delivering in the background: a pairing completes, acknowledgements and card updates are applied, and queued messages are retried without your AI calling a tool. When several AI apps share one agent, only one server does this at a time and another takes over if it stops. Apps that support it can subscribe to `agentlink://inbox` to hear about new messages.
