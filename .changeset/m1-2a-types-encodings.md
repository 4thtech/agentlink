---
'@agentlink/types': minor
---

Add the per-path decoders of 04 §2.4.1: `decodeAtPath` decodes a value by its schema path (never by field name) and returns its bytes, or null for any non-canonical form; `equalAtPaths` compares two encoded values as bytes, each decoded by its own path; `ENCODING_PATHS` and `isEncodingPath` list the table. **BREAKING:** the `files[].inline` cap is now the spec's 12 288 bytes of ALF1 ciphertext (16 384 base64url characters, 04 §3.1.1), so `MAX_INLINE_CIPHERTEXT_BYTES` is 12 288 and `MAX_INLINE_FILE_BYTES` (inline plaintext) is 12 255; a longer inline value is rejected.
