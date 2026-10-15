---
'@4thtech/agentlink': minor
---

Add `agentlink mcp`: the stdio MCP server with the frozen M1a tool list (input and output schemas, all four annotations, a committed tool-surface snapshot), the 06 §4 untrusted-content wrapper, and the read-only `agentlink_status` and `agentlink_list_contacts` handlers in the runtime-agnostic `src/tools/` module. `agentlink_get_approval` (waiting on a core read), send, inbox, invites and terms answer "not available yet" for now.
