---
'@4thtech-io/types': patch
'@4thtech-io/core': patch
'@4thtech-io/node': patch
'@4thtech-io/agentlink': patch
---

"Don't also announce on the default servers" (NET-ANNOUNCE-OPTOUT, D-158 (7)): a new owner action, `network.announce`, turns it on or off without changing the list, from the local app (`POST /api/ui/network/announce`, owner presence; the OS sheet names the action, and a server-list change now names "Use {n} message servers"). It is refused while the list holds a default or an old default server. With it on, the ID is fully quiet on the default and old default servers: no publish (owner card-update, card-update copies, the legacy fan-out, a leaving server that is a default one), no read, live subscription or probe there, except a server a contact's own card lists; its own previous servers are still read for 30 days. Pending card-update retries stop naming those servers at once and on every sync pass; the clean-up fails closed, and an opt-out that commits while a card-update is built stores nothing. Contacts' messages, handshakes and card-updates still go to each contact's own list; invites carry the card's own list. A list change that brings a default server back clears the opt-out, and a restore from a recovery kit keeps the list and the choice. No AI app or MCP tool can reach it.
