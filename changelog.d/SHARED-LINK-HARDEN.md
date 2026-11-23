---
section: Fixed
---

- The shared server connection is sturdier. It is still off by default; AGENTLINK_SHARED_RELAYS=1 turns it on. A program that opens more than eight IDs at once now shares all of them instead of sending some on their own connections. A program that was turned away by the shared connection (another version, or another token) tries again about every 30 seconds, so it joins once a compatible program holds the connection. The local socket must be readable by your user only after it is created, and a failed permission change is logged with a fixed code. `agentlink ui` now hosts or joins the shared connection like `agentlink mcp`, so its Message network line shows the real state (SHARED-LINK-HARDEN, S2, D-159, 07 §4.2, 04 §4, 08 §1).
