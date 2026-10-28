---
'@4thtech-io/core': patch
'@4thtech-io/node': patch
'@4thtech-io/agentlink': patch
---

U3-flow: `GET /api/ui/flow?since=<cursor>` answers the live connections map's metadata for the open agent (`{now, cursor, items: [{contactId, direction, kind, state, at}], partial}`), through a new read-only core view `MessagesView.flowEvents`. Never content, names, links, keys, hashes or envelope IDs; at most 200 items and 20 000 bytes; no byte progress (the store records none).
