---
section: Added
---

- Owner-signed own storage and recovery-kit export in the core (M1-9i-a, S2, D-115; 04 §2.5.1, 07 §3.4, §5.6): the `storage.set`, `storage.remove` and `backup.export` owner actions, the `own_storage` store table (schema version 5) with its anti-rollback `storage-mark`, and a broken own storage that asks you to connect it again instead of ever falling back to the encrypted drop. The `agentlink storage` and `backup` commands come with M1-9i.
