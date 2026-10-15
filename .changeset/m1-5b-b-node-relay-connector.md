---
'@agentlink/node': minor
---

Add the Node relay connector, host resolver and NIP-11 fetcher for the relay pool of `@agentlink/transport-nostr`. Each relay connection goes to the address the pool checked, never to a second lookup of the name, with TLS and the `Host` header on the relay's host name; redirects are refused and proxy settings are ignored, for the WebSocket and for the NIP-11 read. Inbound messages over 131 072 bytes close the socket before they reach the pool, compression is not negotiated, and the NIP-11 read is capped at 65 536 bytes with its own 5-second deadline. New dependency: `ws` 8.22.0 (no dependencies, no install script).
