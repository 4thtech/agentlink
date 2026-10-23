---
'@4thtech-io/submitter': patch
---

A held item (the Notary paused, or the chain unreadable) now stops retrying 24 hours after the submitter first took it (`SUBMITTER_MAX_HELD_SECONDS`, 300 s to 7 days), or at its own deadline if that comes first. Past that it is `failed` with `unavailable`, so the queue cannot grow without bound. Clients read the chain after any `failed` answer and may post the item again.
