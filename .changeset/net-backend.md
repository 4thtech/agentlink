---
'@4thtech-io/types': patch
'@4thtech-io/transport-nostr': patch
'@4thtech-io/core': patch
'@4thtech-io/node': patch
'@4thtech-io/agentlink': patch
---

The local app can now show a live view of the message network under the hood: each server's host, whether it answers from this computer, how fast, whether it wants a sign-in or a payment, and how many messages it took and served today (`GET /api/ui/network`, a `network` live event, store version 23 `relay_stats`, counters only). The check runs only while that view is open and only against your own servers. Your own server list is now limited to 2 to 8 servers, as the spec says.
