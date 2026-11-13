---
section: Changed
---

- The local store moves to schema version 15 (RET-2, S2, 07 §3.8, D-148): a `deleted_at` tombstone column on messages and a private `saved_files` index of the files AgentLink saved into the Inbox folder, kept after the 7-day file-key shred; files saved in the last 7 days are indexed once on first start (missing files and links are skipped), and the store file switches once to incremental space recovery when the disk has room. Nothing is deleted yet; the delete and retention settings come with RET-3 and later. An older version cannot open the updated store.
