---
section: Changed
---

- New default relays: offchain.pub and nostr.bitcoiner.social replace nos.lol and nostr.mom, after a live read-back check (RELAY-DEFAULTS-SWAP, S1, D-75, 07 §4). New invites list only the new set. For now AgentLink still reads from the two old relays so nothing waiting there is lost, never sends to them by itself, and still reaches contacts whose invite lists them.
