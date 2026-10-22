---
'@4thtech-io/transport-nostr': minor
---

Sync now closes a relay-cap gap when another relay of the pass read that second in full: one bounded `ids` query on the capped relay confirms it holds the wraps it hid (at most 64 ids per gap, 16 queries per pass, 1 s each, inside the pass budget). Gaps it cannot close stay in the sync result as before (M2-19).
