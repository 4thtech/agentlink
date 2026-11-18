---
'@4thtech-io/core': patch
'@4thtech-io/mcp-tools': patch
---

SEC-TERMS-CAPS (D-156): offers, accepts and rejects sent through the terms tools now count toward the sending limits, together with messages, and are refused over a limit with the same `SEND_LIMIT` result and words as `agentlink_send`.
