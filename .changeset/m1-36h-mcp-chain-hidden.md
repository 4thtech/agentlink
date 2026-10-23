---
'@4thtech-io/agentlink': minor
---

The MCP server's default tool surface no longer lists the `chain` argument of `agentlink_notarize`, and its description no longer names it: the proof network is always picked automatically. A call that passes `chain` anyway is refused with `INVALID_ARGUMENT`. `agentlink mcp --advanced` serves the Advanced surface, where the optional override is still available. The server instructions now say "add a public proof" and "adding proof", and tell the AI never to ask the user to choose a network.
