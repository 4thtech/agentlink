---
'@4thtech-io/types': minor
'@4thtech-io/core': minor
'@4thtech-io/node': patch
---

Owner-signed own storage and recovery-kit export (M1-9i-a, D-115). `@4thtech-io/types` adds the `storage.set`, `storage.remove` and `backup.export` owner actions with strict params (L(op) = 600 s), `STORAGE_PROVIDERS`, `BACKUP_KIT_CONTENTS` and `isCanonicalS3Endpoint`. `@4thtech-io/core` applies them (nonce row and the one `own_storage` row in one transaction, then the KeyStore `storage-mark`), adds `ownStorage.load()` (`none`, `ready` or `broken`, re-verified on every load, never by expiry), the `OwnStorageKeys` interface and the `storage-mark` codec, and the `brokenOwnStorageAdapter` stub: a broken own storage makes a stored file send `needs_setup` `storage_broken`, never the drop. Store schema version 5 adds `own_storage`; `@4thtech-io/node` migrates SQLite stores to it.
