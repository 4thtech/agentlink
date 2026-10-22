---
'@4thtech-io/core': patch
---

Retention at expiry and crypto-shredding (M1-7f-2; 04 §4, D-98). At ingest the core moves each inbound `fileKey` into a sealed receiver `files` row and stores the payload with a placeholder key; `fetchFile` reads the key from that row (a payload stored earlier still uses its own key). New `deleteExpiredFiles()`, also run by `syncInbox`: at `expiresAt` the sender deletes the stored object (the drop with a DELETE signed at the upload epoch) and its `files` row, and the receiver deletes its row. The delete-on-receipt pass now deletes the row instead of marking `deleted_at`.
