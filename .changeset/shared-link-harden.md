---
'@4thtech-io/agentlink': patch
---

Shared server connection (still off by default; AGENTLINK_SHARED_RELAYS=1 turns it on): a program that opens many IDs at once shares every one of them, a program that could not join the shared connection tries again every 30 seconds or so, the local socket is checked to be private after it is created, and `agentlink ui` now hosts or joins the shared connection like `agentlink mcp` (SHARED-LINK-HARDEN).
