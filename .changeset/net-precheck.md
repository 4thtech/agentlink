---
'@4thtech-io/crypto': patch
'@4thtech-io/transport-nostr': patch
'@4thtech-io/node': patch
'@4thtech-io/agentlink': patch
---

The local app can test a server address before you use it (`POST /api/ui/network/test`, Under the hood only): up to 8 `wss://` addresses, each checked against the server address rules and the public internet only (every DNS answer must be public, then the address is pinned). A tiny test message signed by a one-time key, never your ID's key, must be accepted without a login and read back on a fresh connection, by its id and by the filter AgentLink reads with. Each answers ready, slow, sign-in or refused with a plain reason (not accepted, not kept, unreachable, not allowed, too small, invalid), with sign-in and payment warnings. At most 10 tests a minute, 10 s per server; nothing is saved or signed by your ID.
