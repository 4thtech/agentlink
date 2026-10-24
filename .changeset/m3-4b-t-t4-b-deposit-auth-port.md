---
'@4thtech-io/agentlink': patch
---

Internal: the runtime port for the coming owner-approved gasless top-up (M3-4b-t-T4-b). It posts a signed deposit authorization to the shipped submitter URLs only and maps the answer to a fixed outcome (`submitted`, `rate_limited` with the Retry-After seconds, `already_used`, `unavailable`, `refused`). Off by default: it sends nothing while the chain package's kill switch is off, no MCP tool can reach it, and nothing changes for users yet.
