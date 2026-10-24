# @4thtech-io/storage

## 0.2.0

### Patch Changes

- 82a60e6: Storage follow-ups (M1-6b-b): the lifecycle update re-reads before writing and checks the result, errors thrown by a caller's stream surface as a fixed StorageError, and an upload whose create or complete answer was lost is aborted or its object removed.
- 607dc70: M1-6b-c: the lifecycle helper's read-back now compares the full content of every rule, not only the rule IDs, so a rule another writer changed in place is reported as `lifecycle_failed`.
- 2286724: M1-6b-d: `apply()` on the lifecycle helper now returns `{ abortIncomplete, warning }`; when the provider drops the abort-incomplete-upload element it reports `dropped` with a plain-words warning (still a success).
- Updated dependencies [9c56860]
- Updated dependencies [cb4a63a]
- Updated dependencies [3a3837b]
- Updated dependencies [4be1e27]
- Updated dependencies [0ece43e]
- Updated dependencies [c6aa21f]
- Updated dependencies [9dbaa44]
  - @4thtech-io/log@0.2.0
  - @4thtech-io/crypto@0.2.0

## 0.1.2

### Patch Changes

- 84bda36: M1-1g-g: a file shared through the encrypted drop stays deletable after a key rotation. The drop adapter records the drop key epoch of each upload and signs its delete with that epoch's key; the core keeps the epoch in the sealed file record.
- 942b276: The encrypted-drop adapter and storage selection: `createDropAdapter` uploads ALF1 ciphertext to the 4thTech drop (signed upload, PUT, signed commit with the streamed SHA-256, signed delete) through an injected drop-key signer, refuses any off-origin or non-https upload or download URL, and maps the drop's errors to typed codes (`needs_setup` for size and quota limits; retryable `rate_limited` and `unavailable`). `selectStorage`, `resolveStorage`, `selectionForError` and `planInline` (G-27 option a) apply 07 §5.6. The S3 adapter's `put` now routes objects above 64 MiB to multipart upload.
- 19e234d: M1-7f: files in the core. `sendMessage({files})` checks every file (size cap, realpath strictly inside an allowed folder, storage) and the D-85 inline plan, refusing `PAYLOAD_TOO_LARGE` before any read or upload, then encrypts each file with a fresh key (inline, own storage, or the encrypted drop signed through `KeyStore.signDropRequest`) and stores sealed `files` rows; uploads are deleted on any later failure. `fetchFile({envelopeId, fileIndex})` applies the receive cap, the expiry and the URL check, verifies inline ciphertext before decryption and saves through a quarantine file (D-84) under a sanitised, never-overwriting name. `isInsideFolder` is one helper with an explicit `self` rule, used by the path guard and the policy engine. New: the `files` client option (`FilesPlatform`), `withNameSuffix`, `planPacking` and `measurePayload`.
  
  `@4thtech-io/storage`: the response helpers move from the S3 session into `http.ts`, so the drop adapter no longer imports the S3 signer (aws4fetch) and a bundle that uses only the drop does not load it. No behaviour change.
- Updated dependencies [dd9650b]
- Updated dependencies [4d7d3e4]
- Updated dependencies [2e6b70e]
  - @4thtech-io/crypto@0.1.2
  - @4thtech-io/log@0.1.2

## 0.1.1

### Patch Changes

- c4c1f86: Storage adapters: the `StorageAdapter` interface, the inline adapter (up to 12 288 bytes of ciphertext) and the S3-compatible adapter over `aws4fetch` (upload, presigned download clamped to 7 days and to credential expiry, delete)
- 9f3ad1b: Multipart upload for S3-compatible storage (streams ciphertext in adaptive parts, hashes it incrementally, aborts the upload on any failure, cleans up open uploads under the agent's own prefix) and a bucket lifecycle helper that sets and reads back a rule deleting `agentlink/` objects after 30 days while keeping the bucket's other rules
- 379d2d4: Streaming encryption for storage uploads and downloads: `putEncrypted` encrypts a file stream with a fresh file key (ALF1 STREAM) straight into an upload (the S3 multipart upload aborts on any failure), `decryptDownload` decrypts a download with a byte cap and both hash checks, and `createTempFileSink` keeps the output in a temporary file that is renamed only after the whole file verified and removed on any failure
- Updated dependencies [4dcc340]
- Updated dependencies [af00aaa]
- Updated dependencies [b26ef46]
- Updated dependencies [2a6716d]
- Updated dependencies [e768cd1]
  - @agentlink/crypto@0.1.1
  - @agentlink/log@0.1.1

## 0.1.0

### Patch Changes

- Updated dependencies [0baa0a5]
- Updated dependencies [7121fa2]
- Updated dependencies [2172526]
- Updated dependencies [9c27388]
- Updated dependencies [32b70f5]
- Updated dependencies [cb7c956]
- Updated dependencies [fecd9a3]
- Updated dependencies [4287032]
- Updated dependencies [1feb21c]
- Updated dependencies [39b1d8c]
- Updated dependencies [e02996f]
  - @agentlink/crypto@0.1.0
