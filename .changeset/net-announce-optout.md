---
'@4thtech-io/types': patch
'@4thtech-io/core': patch
'@4thtech-io/node': patch
'@4thtech-io/agentlink': patch
---

"Don't also announce on the default servers" (NET-ANNOUNCE-OPTOUT, D-158 (7)): a new owner action, `network.announce`, turns it on or off without changing the list, from the local app (`POST /api/ui/network/announce`, owner presence; the OS sheet names the action, and a server-list change now names "Use {n} message servers"). It is refused while the list holds a default or an old default server. With it on, nothing about the ID goes to the default servers: the owner card-update keeps to the own and leaving servers, the legacy card-update fan-out to contacts stops, and pending card-update retries stop naming default servers at once and on every sync pass. Contacts' messages, handshakes and card-updates still go to each contact's own list; invites carry the card's own list. A list change that brings a default server back clears the opt-out, and a restore from a recovery kit keeps the list and the choice. No AI app or MCP tool can reach it.
