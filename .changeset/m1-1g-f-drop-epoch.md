---
'@4thtech-io/crypto': patch
'@4thtech-io/node': patch
---

M1-1g-f: `KeyStore.signDropRequest(request, createdAt, options?)` takes an optional `{epoch}` for a DELETE, so an object uploaded under an older key epoch stays deletable after a rotation (04 §2.1). It is accepted only with DELETE and never above the current epoch (`epoch_unavailable`); a POST with an epoch or a malformed epoch gets the same fixed refusal, and every check runs before a key is read. Implemented by `MemoryKeyStore` and the keychain KeyStore (and its facade). `dropRequestEpoch` joins `dropRequestSnapshot` in the main entry.
