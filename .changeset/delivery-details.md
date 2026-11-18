---
'@4thtech-io/core': patch
'@4thtech-io/node': patch
'@4thtech-io/transport-nostr': patch
'@4thtech-io/agentlink': patch
---

Each sent message now keeps how many relays accepted it and how many served it back (store version 20, counts only, no relay addresses). The conversation shows it as "Accepted by 3 relays · available from 2" (hover on the Sent mark; a line under the hood), or "Sent, availability unknown" when nothing could be checked.
