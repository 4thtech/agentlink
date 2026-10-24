---
'@4thtech-io/core': patch
'@4thtech-io/types': patch
---

refresh-link (M1-7f-3; 04 §4, 07 §5.2). New `requestFileLink({envelopeId, fileIndex})` sends a `request` envelope `{kind: "refresh-link", envelopeId, fileIndex}` to the contact that sent a stored file; after each processing pass (`syncInbox`, the live loop) the sender's core answers from its own storage with a `file` envelope carrying the file's entry with a fresh presigned link that never outlives the file's `expiresAt`, and the recipient's core moves that link into its receiver row, so `fetchFile` works again. Only the contact the file was sent to gets an answer; the drop and inline files are not refreshable. `fetchFile` now uses the receiver row's link. The `refresh-link` request body in `@4thtech-io/types` names the file by `fileIndex` instead of `ciphertextSha256` (a request is shown in the inbox, 06 §2.1).
