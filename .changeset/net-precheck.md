---
'@4thtech-io/crypto': patch
'@4thtech-io/transport-nostr': patch
'@4thtech-io/node': patch
'@4thtech-io/agentlink': patch
---

The local app can test a server address before you use it (`POST /api/ui/network/test`, Under the hood only): up to 8 `wss://` addresses, each checked against the server address rules and the public internet only (every DNS answer must be public, then the address is pinned), with a tiny test message signed by a one-time key, never your ID's key, and read back on a fresh connection. Each answers ready, slow, needs sign-in, needs payment or refused with a plain reason. At most 10 tests a minute, 15 s each; nothing is saved or signed by your ID.
