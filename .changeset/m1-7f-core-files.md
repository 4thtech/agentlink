---
'@4thtech-io/core': patch
'@4thtech-io/storage': patch
---

M1-7f: files in the core. `sendMessage({files})` checks every file (size cap, realpath strictly inside an allowed folder, storage) and the D-85 inline plan, refusing `PAYLOAD_TOO_LARGE` before any read or upload, then encrypts each file with a fresh key (inline, own storage, or the encrypted drop signed through `KeyStore.signDropRequest`) and stores sealed `files` rows; uploads are deleted on any later failure. `fetchFile({envelopeId, fileIndex})` applies the receive cap, the expiry and the URL check, verifies inline ciphertext before decryption and saves through a quarantine file (D-84) under a sanitised, never-overwriting name. `isInsideFolder` is one helper with an explicit `self` rule, used by the path guard and the policy engine. New: the `files` client option (`FilesPlatform`), `withNameSuffix`, `planPacking` and `measurePayload`.

`@4thtech-io/storage`: the response helpers move from the S3 session into `http.ts`, so the drop adapter no longer imports the S3 signer (aws4fetch) and a bundle that uses only the drop does not load it. No behaviour change.
