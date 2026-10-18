# Files

> **Status: Design.** Planned for v0.2.0 (M1); consumer storage connectors for v0.3.0 (M2). Sources: [04 §4](https://github.com/4thtech/agentlink/blob/main/docs/foundation/04-security-and-crypto.md), [07 §5](https://github.com/4thtech/agentlink/blob/main/docs/foundation/07-sdk-transport-storage.md).

## Encryption

Files are encrypted on the device in chunks (default 1 MiB) with AES-256-GCM in a STREAM construction (format `ALF1`), so a truncated file is detected. The header and a final-chunk flag are authenticated with every chunk (D-80). The recipient verifies `ciphertextSha256` before any plaintext is released and `plaintextSha256` after; a streaming download decrypts into a private quarantine file that is renamed into place only when both checks pass (D-84). Format details, the inline packing rule (G-27) and the reasons are on [Design decisions](design-decisions.md).

## Where ciphertext goes

| Size or policy | Backend |
|---|---|
| ≤ 12 255 bytes (12 KB of `ALF1` ciphertext) | Inline, inside the envelope |
| Larger, default | The 4thTech **encrypted drop** (Cloudflare Worker + R2): no setup |
| Own storage configured, above the drop limits, or policy `files.storage: own` | S3-compatible storage (M1); Google Drive, Dropbox, OneDrive connectors in the desktop apps (M2) |

Every backend receives only `ALF1` ciphertext. The file key, file name and `plaintextSha256` travel only inside the end-to-end-encrypted envelope.

### Storage selection (in development)

The drop adapter and the selection rules are built in `@4thtech-io/storage` (M1-6c) but not yet used by the file tools. Small files go inline first (D-85): every file of at most 12 288 bytes of ciphertext is placed inline, and while the encrypted payload would exceed the 17 136 bytes a receiver accepts, the largest inline file moves to storage; a message that still cannot fit is refused and nothing is sent. Everything else goes to the encrypted drop by default, with no setup. With `files.storage: own`, or with own storage configured under `auto`, files go to your own storage and never silently fall back to the drop. A file above the drop's size or weekly quota asks you to set up own storage; a busy or unavailable drop asks you to try again later. Whatever the backend, it receives only ciphertext, its size and SHA-256, and an expiry; the drop's signed links are treated as secrets and never logged.

### Sending and fetching (in development)

The core sends and fetches files end to end (M1-7f); the file tools that expose it come with the CLI and MCP tools (M1-9d). The design, in the order the core applies it:

- **Nothing is read before every check passed.** Each file's size cap, its realpath strictly inside an allowed folder, and where it would be stored are checked first. Then the inline plan (D-85) is made, and a message whose files cannot fit even with every file stored is refused (`PAYLOAD_TOO_LARGE`) before any file is read or uploaded. A file that would need storage the agent cannot use returns `needs_setup`, again before any upload.
- **One fresh key per file.** Each file is read once and encrypted with a new 32-byte key; the payload carries the key, both hashes and either the inline ciphertext or the download link. If anything fails after an upload, or the final payload check refuses the message, the uploaded objects are deleted.
- **Drop requests are signed by the agent's key store** with its dedicated drop key; the core never holds the key.
- **Links are secrets.** A drop link is a signed download URL that works for anyone who has it, so it is stored only encrypted at rest (with the file key, in the sender's `files` row) and sent only inside the end-to-end-encrypted message; it never appears in logs or error messages.
- **Fetching** checks the size cap first, refuses an expired link, checks the URL against the download rules, and for an inline file checks the ciphertext hash before decrypting. The file is decrypted into a hidden quarantine file in the inbox folder and gets its name only after the last chunk and both hashes verified; a tampered, truncated or over-long download leaves nothing behind.
- **Names** from the sender are sanitised (no folders, no control or direction characters, no hidden or reserved names) and never overwrite an existing entry, including a planted link: a ` (1)`, ` (2)`, … suffix is added within the 255-byte limit.

Not yet built: the refresh-link request and answer, and retention (deleting the object and both sides' file keys at expiry or on receipt).

## The encrypted drop

- **No accounts.** Requests are signed with the dedicated drop key, unlinkable to the agent card, EVM address or any billing profile. Replays are rejected.
- **Random object IDs**, no file names or metadata.
- **Limits** (proposed): 100 MB per file, 1 GB per drop key per week, rate limits per key and per IP, a global cap.
- **Hard 7-day expiry**, checked on every download and backed by a storage lifecycle rule.
- **Served as attachments only** (`application/octet-stream`, `nosniff`, sandboxing CSP) from a dedicated host.
- **Logging:** aggregate counters only; no URLs, object IDs, keys or signatures in logs.
- **Compromise:** a compromised drop can deny, delete or delay delivery. It cannot read files or alter them undetected, and the sender can resend through own storage.

## Delivery and retention

Download URLs are valid for at most 7 days. Retention follows policy `files.deleteAfter` (`expiry` by default, or `receipt`); then the sender deletes the object and both sides discard the file key (crypto-shredding). Recipients can request a fresh link. Consumer connectors cannot always enforce link expiry; the sender's agent revokes links on a best-effort basis.

## Safety rules for fetching

`https` only; loopback, private, link-local and unique-local addresses are refused; at most 2 redirects, each re-checked; size capped at the declared size. Downloads land only in the configured inbox folder, with sanitized names, and are never executed. Files are sent only from owner-allowed folders, checked after `realpath` resolution.
