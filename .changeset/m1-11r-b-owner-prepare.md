---
'@4thtech-io/core': minor
'@4thtech-io/types': minor
---

Owner-operation prepare helpers for the local UI (M1-11r-b, D-118). `OwnerActions.preparePolicyEdit(patch, options)` builds the unsigned `policy.set` body: the complete 06 §3 document from the verified policy (or the defaults) with a typed patch merged over it, at the version above the KeyStore mark and the stored row; it refuses a strict-schema violation, a stale base version and any edit while the policy fails closed, and signs delivery receipts on from an older default as `false` unless the owner keeps them (D-109). `prepareContactCheck`, `prepareContactRename` and `prepareContactRemove` build the unsigned `contact.*` bodies. `buildOwnerActionBody` is the pure, byte-exact builder (JCS; reproduces the owner-action signing vectors). Nothing here signs: the server signs after presence. `ContactBook.currentPairingDigest` recomputes the pairing digest for `contact.check`. Types: `policyPatchSchema` and `PolicyPatch`.
