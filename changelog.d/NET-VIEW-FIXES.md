---
section: Fixed
---

- Message network (Under the hood): a server that allows only a few connections from one computer (offchain.pub, for example) no longer shows "Can't reach" while it carries your messages. The check now asks over the app's own open connection to that server when there is one, and a card that says "Can't reach" next to a recent success explains why (NET-VIEW-0514-1, S1, 08 §1, 07 §4.2).
- Message network: the banner no longer says AgentLink swaps an unreachable server automatically (a server list changes only through a contact-details update). It counts your own servers ("One of your servers can't be reached"), names old read-only servers apart, and says a message counts as sent once 2 servers accept it (NET-VIEW-0514-1, S1, 08 §1, 11 §5).
- Message network: the "Automatic" label next to Servers is a small static chip in sentence case, no longer a large pill that ran off the edge (NET-VIEW-0514-1, S1, D-116).
