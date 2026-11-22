---
section: Added
---

- The shared server connection is wired in: `agentlink mcp` and the desktop app share one connection to each message server when AGENTLINK_SHARED_RELAYS=1 (off by default in this release), the desktop app takes the connection over when it starts, the availability check and the server Test use the shared check connection, and `agentlink doctor` and Under the hood › Message network show "Shared server connection: on, {n} programs" or "off" (RELAY-SHARED-CONN L4, S2, D-159, 07 §4.2, 04 §4, 08 §1, 11 §5.15).
