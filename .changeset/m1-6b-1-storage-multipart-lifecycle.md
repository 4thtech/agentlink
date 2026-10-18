---
'@agentlink/storage': patch
---

Multipart upload for S3-compatible storage (streams ciphertext in adaptive parts, hashes it incrementally, aborts the upload on any failure, cleans up open uploads under the agent's own prefix) and a bucket lifecycle helper that sets and reads back a rule deleting `agentlink/` objects after 30 days while keeping the bucket's other rules
