# Files

> **Status: Available since v0.2.0** (sending and fetching files through the MCP tools, M1-9d-1); **automatic saving, Save to Inbox in the app and the Inbox folder rules since v0.4.6** (31 Oct 2026). The encrypted drop serves ciphertext for testers on the test networks; consumer storage connectors are planned for the desktop apps (M2). Sources: [04 §4](https://github.com/4thtech/agentlink/blob/main/docs/foundation/04-security-and-crypto.md), [07 §5](https://github.com/4thtech/agentlink/blob/main/docs/foundation/07-sdk-transport-storage.md).

## Encryption

Files are encrypted on the device in chunks (default 1 MiB) with AES-256-GCM in a STREAM construction (format `ALF1`), so a truncated file is detected. The header and a final-chunk flag are authenticated with every chunk (D-80). The recipient verifies `ciphertextSha256` before any plaintext is released and `plaintextSha256` after; a streaming download decrypts into a private quarantine file that is renamed into place only when both checks pass (D-84). Format details, the inline packing rule (G-27) and the reasons are on [Design decisions](design-decisions.md).

## Where ciphertext goes

| Size or policy | Backend |
|---|---|
| ≤ 12 255 bytes (12 KB of `ALF1` ciphertext) | Inline, inside the envelope |
| Larger, default | The 4thTech **encrypted drop** (Cloudflare Worker + R2): no setup |
| Own storage configured, above the drop limits, or policy `files.storage: own` | S3-compatible storage (M1); Google Drive, Dropbox, OneDrive connectors in the desktop apps (M2) |

Every backend receives only `ALF1` ciphertext. The file key, file name and `plaintextSha256` travel only inside the end-to-end-encrypted envelope.

### Storage selection

The drop adapter and the selection rules are built in `@4thtech-io/storage` (M1-6c) and used by the file tools since v0.2.0 (M1-9d-1). Small files go inline first (D-85): every file of at most 12 288 bytes of ciphertext is placed inline, and while the encrypted payload would exceed the 17 136 bytes a receiver accepts, the largest inline file moves to storage; a message that still cannot fit is refused and nothing is sent. Everything else goes to the encrypted drop by default, with no setup. With `files.storage: own`, or with own storage configured under `auto`, files go to your own storage and never silently fall back to the drop. A file above the drop's size or weekly quota asks you to set up own storage; a busy or unavailable drop asks you to try again later. Whatever the backend, it receives only ciphertext, its size and SHA-256, and an expiry; the drop's signed links are treated as secrets and never logged.

### Sending and fetching

The core sends and fetches files end to end (M1-7f); the MCP file tools that expose it (`agentlink_send` with `path`, `agentlink_fetch_file`; M1-9d-1) are released (v0.2.0). The design, in the order the core applies it:

- **Nothing is read before every check passed.** Each file's size cap, its realpath strictly inside an allowed folder, and where it would be stored are checked first. Then the inline plan (D-85) is made, and a message whose files cannot fit even with every file stored is refused (`PAYLOAD_TOO_LARGE`) before any file is read or uploaded. A file that would need storage the agent cannot use returns `needs_setup`, again before any upload.
- **One fresh key per file.** Each file is read once and encrypted with a new 32-byte key; the payload carries the key, both hashes and either the inline ciphertext or the download link. If anything fails after an upload, or the final payload check refuses the message, the uploaded objects are deleted.
- **Drop requests are signed by the agent's key store** with its dedicated drop key; the core never holds the key.
- **Links are secrets.** A drop link is a signed download URL that works for anyone who has it, so it is stored only encrypted at rest (with the file key, in the sender's `files` row) and sent only inside the end-to-end-encrypted message; it never appears in logs or error messages.
- **Fetching** checks the size cap first, refuses an expired link, checks the URL against the download rules, and for an inline file checks the ciphertext hash before decrypting. The file is decrypted into a hidden quarantine file in the inbox folder and gets its name only after the last chunk and both hashes verified; a tampered, truncated or over-long download leaves nothing behind.
- **Names** from the sender are sanitised (no folders, no control or direction characters, no hidden or reserved names) and never overwrite an existing entry, including a planted link: a ` (1)`, ` (2)`, … suffix is added within the 255-byte limit.

### The CLI's file platform (M1-9d-1)

The core does no file-system or network I/O itself; the CLI supplies it (`apps/cli/src/runtime/files.ts`):

- **`path` arguments** are checked by `@4thtech-io/node`'s allowed-folder guard (M1-15) before the core is called: realpath on both sides, strictly inside an allowed folder, no hidden segment, outside the protected roots (`~/.ssh`, `~/.agentlink`, the keychain folders, in lexical and resolved form), a regular file. A refused path is never opened. The file is opened only when the core reads it, through the guard's checked open (the full check again after the open, same device and inode, no final link followed), and is hashed while it is read so the result can report `plaintextSha256`.
- **The inbox folder** (`files.inboxFolder`, `~/AgentLink/Inbox` by default) is created with mode 0700 when missing, and refused when any segment is hidden or it lies under a protected root. Files are created exclusively with mode 0600 without following a link, and the final rename never overwrites (a hard link, then the temporary name is removed).
- **Downloads** go through the SSRF-safe fetch (M1-15): https only, public addresses only, DNS pinned, redirects capped and re-checked, the byte cap applied.
- **The drop** (`drop.agentlink.4thtech.io` by default) is reached only with https requests to exactly that origin, with no user info and no redirects followed; the drop adapter also checks every link the drop returns against that origin.
- **Tool results** carry a file's name, size, hash, delivery and expiry only. The drop link, the locator and the file key never reach the tool layer, and a sender's file name appears only inside the untrusted-content block.

A send retried after a crash between the upload and the stored message uploads the file again; the first copy is never referenced and expires with the drop or the storage lifecycle rule (the residual of 07 §3.3).

Not yet built (M1-7f-2): the refresh-link request and answer, and retention (deleting the object and both sides' file keys at expiry or on receipt). On the receiving side the core will move each file key out of the stored message into its own sealed `files` row at ingest, so retention can delete it (D-98).

## Automatic saving (since 0.4.6)

Source: [04 §4.1](https://github.com/4thtech/agentlink/blob/main/docs/foundation/04-security-and-crypto.md) (D-142, W4-AUTO-SAVE). Before 0.4.6 a received file was downloaded only when you or your AI asked. Now a contact you keep can cause a file to land on your disk without a click, so the rules are strict.

- **Who saves.** Only the process that holds the agent's publisher lease, in its background loop, after the message is verified and stored. With no AgentLink process running, files are saved when one runs next, until they expire.
- **Which files.** Only from a contact that is paired, allowed and not blocked or removed (checked when the message is stored and again right before the download); never from an unknown sender, never for a file named in a request, never while the agent is paused, and only for files whose message the agent stored after it ran with this feature. A file that arrives while the agent is paused is not saved on resume; it waits for Save, so resuming never starts a burst of downloads.
- **Limits** (a cost bound, not a security boundary), counted over rolling 24 hours in the agent's store as counts and bytes only: 50 files and 500 MB per contact, 200 files and 2 GB for all contacts, plus the usual per-file cap (`files.maxReceiveSizeMB`, 200 by default). At most 2 downloads run at a time and a failed one is retried after 1 minute, 10 minutes and 1 hour. At least 1 GiB must stay free on the disk. A file over a limit is never refused: it reads "Arrived · not saved" and waits for Save to Inbox.
- **Your controls.** Policy `files.autoSave.on` (on by default; a policy signed before 0.4.6 is read as on) and, per contact, `askBeforeSaving`. In 0.4.6 the app shows the Inbox folder on Home and each file's state; screens for the on and off switch, "Ask before saving" and choosing another folder are not built yet.
- **The folder.** `files.inboxFolder`, `~/AgentLink/Inbox` by default, created with mode 0700 when missing. A chosen folder must be an existing directory owned by you, not hidden, not an operating-system or app folder, and not inside or containing an allowed send folder, so a received file never becomes sendable by your AI without you moving it.
- **Writing the file.** The folder is resolved with realpath at every save and used through a directory handle, never through the path again. The file is decrypted into a hidden temporary file (created exclusively, mode 0600, never executable), given the operating system's "downloaded from the internet" mark (`com.apple.quarantine` on macOS, Mark-of-the-Web on Windows), verified against both hashes, and moved into place with a no-replace rename, so nothing is ever replaced. If the mark cannot be set, nothing is saved automatically and the file waits for Save. Linux has no such mark, an accepted residual for 0.4.6.
- **Names.** The sender's name is untrusted text: path parts, control, direction-changing and zero-width characters are removed, hidden and reserved names are fixed, and a numbered suffix is added when the name exists. Names that the system shell would act on when only showing the folder, or that run when double-clicked (for example `.exe`, `.bat`, `.command`, `.webloc`, `.lnk`, `.desktop`), get `.download` appended. AgentLink never opens, previews, unpacks or runs a received file.
- **Save to Inbox in the app** (`file.save`, W4-FILES-SAVE). For a file that was not saved automatically, the app asks for Touch ID (or the backup code) and the owner signs `file.save` with only the agent, the message ID and the file's index in it. The app never sends a name, folder or path; the core saves with its own fetch into the Inbox folder, then Home shows "Saved to ~/AgentLink/Inbox" and a Show in Finder (Show in Explorer on Windows, Show in folder on Linux) action. No AI app tool can sign `file.save`.
- **One copy.** Automatic saving, Save to Inbox and `agentlink_fetch_file` share one lock per file and the store records the name the file got, so a file already saved is not saved again. The lock is per process; across processes a rare race can leave a second copy named "name (2)", and nothing is overwritten.

## The encrypted drop

- **No accounts.** Requests are signed with the dedicated drop key, unlinkable to the agent card, EVM address or any billing profile. Replays are rejected.
- **Random object IDs**, no file names or metadata.
- **Limits** (proposed): 100 MB per file, 1 GB per drop key per week, rate limits per key and per IP, a global cap.
- **Hard 7-day expiry**, checked on every download and backed by a storage lifecycle rule.
- **Served as attachments only** (`application/octet-stream`, `nosniff`, sandboxing CSP) from a dedicated host.
- **Logging:** aggregate counters only; no URLs, object IDs, keys or signatures in logs.
- **Compromise:** a compromised drop can deny, delete or delay delivery. It cannot read files or alter them undetected, and the sender can resend through own storage.

## Delivery and retention

Download URLs are valid for at most 7 days. Retention follows policy `files.deleteAfter` (`expiry` by default, or `receipt`); then the sender deletes the object and both sides discard the file key (crypto-shredding). Relay and owner copies of the message still carry the key inside the end-to-end encryption, so the effective shred is deleting the object (D-98). Recipients can request a fresh link. Consumer connectors cannot always enforce link expiry; the sender's agent revokes links on a best-effort basis.

## Safety rules for fetching

`https` only; loopback, private, link-local and unique-local addresses are refused; at most 2 redirects, each re-checked; size capped at the declared size. Downloads (automatic or on request) land only in the configured inbox folder, with sanitized names, and are never executed. Files are sent only from owner-allowed folders, checked after `realpath` resolution.
