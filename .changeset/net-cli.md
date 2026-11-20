---
'@4thtech-io/node': patch
'@4thtech-io/agentlink': patch
---

`agentlink owner servers`: choose your own message servers from your own terminal. `list` shows your servers with their role and a quick health check, whether AgentLink's automatic servers are mixed in, the announce choice, and the old servers still read with their end dates; `test <wss://…>…` runs the app's server test (same limits) and prints plain outcomes and reasons. Both take `--json` and need no master code. `set <wss://…>… [--no-automatic] [--no-announce]` and `reset` run only at an interactive terminal (piped input and an AI app's terminal are refused), show the review first (the list, the old servers and until when they are read, the contacts told, warnings including the "only your servers will know this ID" one), then ask for your master code and sign through the same path as the app. `--no-announce` needs `--no-automatic`. No AI app or MCP tool can reach the change (NET-CLI, D-158).
