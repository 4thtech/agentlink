---
section: Changed
---

- Files: when a file's link expires, the sender deletes the stored copy (own storage or the encrypted drop) and both agents delete their copy of the file key, under `files.deleteAfter: expiry` and also under `receipt` when no delivery receipt arrived. Nothing is deleted before the link expires (M1-7f-2, S2, 04 §4, D-98).
- Files: a received file's key is now kept in its own sealed local record instead of the stored message, so it can be deleted on its own; after retention the file can no longer be opened from this agent (M1-7f-2, S2).
- Files: a delete on receipt now also deletes the sender's file key (M1-7f-2, S2).
