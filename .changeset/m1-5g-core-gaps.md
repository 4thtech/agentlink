---
'@4thtech-io/core': minor
'@4thtech-io/agentlink': minor
---

When a message network server returns only part of a busy second, your agent now says that some messages may be missing from that check and that it looks again on the next one. Core sync results carry this as an `incomplete` count only (M1-5g).
