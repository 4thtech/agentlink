---
'@agentlink/storage': patch
---

Streaming encryption for storage uploads and downloads: `putEncrypted` encrypts a file stream with a fresh file key (ALF1 STREAM) straight into an upload (the S3 multipart upload aborts on any failure), `decryptDownload` decrypts a download with a byte cap and both hash checks, and `createTempFileSink` keeps the output in a temporary file that is renamed only after the whole file verified and removed on any failure
