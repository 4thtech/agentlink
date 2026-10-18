---
'@4thtech-io/core': patch
---

M1-7f: files in the core. `sendMessage({files})` checks every file (size cap, realpath strictly inside an allowed folder, storage) and the D-85 inline plan, refusing `PAYLOAD_TOO_LARGE` before any read or upload, then encrypts each file with a fresh key (inline, own storage, or the encrypted drop signed through `KeyStore.signDropRequest`) and stores sealed `files` rows; uploads are deleted on any later failure. `fetchFile({envelopeId, fileIndex})` applies the receive cap, the expiry and the URL check, verifies inline ciphertext before decryption and saves through a quarantine file (D-84) under a sanitised, never-overwriting name. `isInsideFolder` is one helper with an explicit `self` rule, used by the path guard and the policy engine. New: the `files` client option (`FilesPlatform`), `withNameSuffix`, `planPacking` and `measurePayload`.
