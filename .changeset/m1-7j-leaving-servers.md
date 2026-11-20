---
'@4thtech-io/core': patch
'@4thtech-io/node': patch
---

Servers that leave an ID's own list stay readable for 30 days, each with its own end (`identity.prev_relays`, at most 16; a change that needs more is refused with `too_many_previous` and the date it fits). Catch-up and the live subscription read the own list, the leaving servers and the legacy relays; only card-updates are published to the leaving servers. The owner card-update is now sent on the owner channel for every new card, to the new list, the leaving servers and the default set, and re-published every 24 h while a leaving server runs, otherwise every 7 days. `identity.announce_default` is stored, restored and exposed for the announce opt-out. Store schema version 24 (M1-7j, D-158).
