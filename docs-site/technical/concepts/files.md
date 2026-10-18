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
