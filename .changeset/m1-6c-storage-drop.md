---
'@4thtech-io/storage': patch
---

The encrypted-drop adapter and storage selection: `createDropAdapter` uploads ALF1 ciphertext to the 4thTech drop (signed upload, PUT, signed commit with the streamed SHA-256, signed delete) through an injected drop-key signer, refuses any off-origin or non-https upload or download URL, and maps the drop's errors to typed codes (`needs_setup` for size and quota limits; retryable `rate_limited` and `unavailable`). `selectStorage`, `resolveStorage`, `selectionForError` and `planInline` (G-27 option a) apply 07 §5.6. The S3 adapter's `put` now routes objects above 64 MiB to multipart upload.
