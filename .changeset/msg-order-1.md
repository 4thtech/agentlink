---
'@4thtech-io/core': patch
'@4thtech-io/node': patch
---

MSG-ORDER-1 + OUTBOX-NOW-1: messages of the same second keep their order in a conversation (a local store order breaks the tie), and queued messages go out at once when the relays come back (core `outbox.retryNow()`, called on reconnect).
