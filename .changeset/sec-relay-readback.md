---
'@4thtech-io/transport-nostr': patch
'@4thtech-io/core': patch
'@4thtech-io/mcp-tools': patch
'@4thtech-io/node': patch
'@4thtech-io/agentlink': patch
---

SEC-RELAY-READBACK (D-156 (7)): a message counts as sent only once a relay that accepted it hands it back when asked by its id, on a separate connection and without signing in (`RelayPool.checkServed`, bounded to 5 s, at most 16 at once, the relay address rule applies). If no relay can be asked, the message is sent with availability unknown: the outbox row and the envelope record `availability`, `agentlink_send` returns `availability: "unknown"` with `delivery: "sent"`, and the app shows "Sent, availability unknown". A relay that accepts a message without handing it back does not count; the outbox keeps trying the others. Store schema version 19 adds `outbox.availability` and `envelopes.availability` (nullable; existing rows unchanged).
