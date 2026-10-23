---
'@4thtech-io/transport-nostr': patch
---

Relay hardening: the NIP-11 fetch has its own 3 s and 64 KiB bound, so a hanging relay information server no longer makes a working relay time out for a publish. A closed pool reports `pool_closed` instead of `invalid_url`. Relay health shows the origin only. The outbox reports why a row with fewer than 2 usable relays cannot be sent, and spreads its retries with jitter.
