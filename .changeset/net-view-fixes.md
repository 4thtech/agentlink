---
'@4thtech-io/transport-nostr': patch
'@4thtech-io/core': patch
'@4thtech-io/node': patch
'@4thtech-io/agentlink': patch
---

Message network view fixes: a server's check now asks over the app's own open connection to it when there is one, so a server that allows only a few connections from one computer no longer shows "Can't reach" while it carries your messages. The banner no longer promises an automatic server swap; it counts your own servers, names the old read-only ones apart and says a message counts as sent once 2 servers accept it. The "Automatic" label is a small, static chip.
