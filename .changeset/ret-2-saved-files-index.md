---
'@4thtech-io/agentlink': patch
---

RET-2: store schema 15. Messages get a `deleted_at` tombstone column (for the later delete on this computer), and AgentLink keeps a private index of the files it saved into the Inbox folder that outlives the 7-day file-key shred. Files saved before this version are indexed once where still possible. The store switches once to incremental space recovery when there is room on the disk.
