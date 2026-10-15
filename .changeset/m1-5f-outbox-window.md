---
'@agentlink/transport-nostr': minor
---

The outbox stops republishing a wrap once a receiver's sync could no longer find it (G-49, D-71 (5); 07 §3.2, §4.2). `OutboxWorker` now takes give_up_at as the earliest of the stored value, `created_at + 24 h` and the signed wrap's own `created_at + SYNC_LOOKBACK_SECONDS + SYNC_SKEW_SECONDS` (48 h + 300 s), recomputed from `wrap_json` on every pass, and schedules no retry past it. A row that reaches the bound without 2 `OK`s is `not_delivered` (timeout), as before; a wrap dated close to 48 h back therefore gets a short retry window. Revisit in M2.
