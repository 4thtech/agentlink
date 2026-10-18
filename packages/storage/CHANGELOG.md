# @agentlink/storage

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
