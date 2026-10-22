---
'@4thtech-io/crypto': minor
---

`credentialDigest` and `credentialDigestOfItem` (04 §2.5.1 `storage.set`; M1-9i-b2) and the `StorageCredential` types in the main entry; `encodeStorageCredentialItem` and `parseStorageCredentialItem` for the `s3:<id>` item (04 §2.2) in `@4thtech-io/crypto/keystore`. The owner-flow control types `KeyExportControl`, `KeyImportControl` and `StorageCredentialControl` (with `DisplayCode`, `RecoveryKitImport` and the `item_exists` KeyStore error code) for the backends of M1-9i-c. The `recovery-kit` vector suite is now version 2 with the `credentialDigest` cases.
