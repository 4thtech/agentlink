---
'@4thtech-io/core': patch
'@4thtech-io/node': patch
'@4thtech-io/transport-nostr': patch
'@4thtech-io/agentlink': patch
---

Each sent message now keeps how many relays accepted it and how many served it back (store version 20, counts only, no relay addresses). The conversation shows it as "Message network: accepted by 3, available from 2" (a line under the hood only), or "Sent, availability unknown" when nothing could be checked.
