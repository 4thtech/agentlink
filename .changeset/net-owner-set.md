---
'@4thtech-io/core': patch
'@4thtech-io/node': patch
'@4thtech-io/agentlink': patch
---

Save your own server list in the local app (Advanced › Message network, Under the hood only): `POST /api/ui/network/servers` and `POST /api/ui/network/reset` are owner operations with presence. The app tests every server again on this computer before anything is signed (at least 2 of your own must be ready; slow counts as ready; a server that needs sign-in needs 2 other ready ones), mixes in 2 of AgentLink's automatic servers by default (they count toward the 8), shows the review first (the list with each server's role, the servers that leave and until when they are still read, how many contacts are told, and warnings), then signs exactly one new card with one gesture. A change that would keep more than 16 leaving servers is refused with the date it fits from. Contacts get the new details through the usual card-update, `GET /api/ui/network/progress` shows who has them, and the announce choice is stored with the card (an interrupted change keeps it when it finishes on the next open). Reset is the same path to the automatic servers. No AI app or MCP tool can reach any of it (NET-OWNER-SET, D-158).
