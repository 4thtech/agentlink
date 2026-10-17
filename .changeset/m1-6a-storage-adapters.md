---
'@agentlink/storage': patch
---

Storage adapters: the `StorageAdapter` interface, the inline adapter (up to 12 288 bytes of ciphertext) and the S3-compatible adapter over `aws4fetch` (upload, presigned download clamped to 7 days and to credential expiry, delete)
