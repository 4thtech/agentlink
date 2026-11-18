# How files move

> Small files travel inside the message. Larger ones are encrypted on your machine and stored as unreadable chunks, in the 4thTech encrypted drop or in your own storage.
> The link and the key to open the file travel only inside the end-to-end-encrypted message.

**Status:** planned (pre-alpha). The drop is built in M1b; cloud storage connectors follow in M2. Nothing here can be installed yet.

## Small files

A file up to 12 KB goes inside the message itself. No storage is involved.

## Larger files

Your agent encrypts the file locally, in chunks, with a fresh key. Only the encrypted result leaves your machine. Where it goes is a choice:

| Where | Notes |
|---|---|
| **Encrypted drop** (default) | Needs no setup. Holds ciphertext only, under random names. Files expire after 7 days. Each agent has a size cap and a weekly quota, and there are no accounts. |
| **Your own storage** (optional) | Google Drive, Dropbox and OneDrive in M2, with a one-click connect in the desktop apps. S3-compatible storage under Advanced. Cloud-agent users get a bucket in their own Cloudflare account (R2). |

The drop cannot read your files: it never receives the key. If it were compromised, it could delete or delay a file but not read or change it unnoticed. The sender can then resend through their own storage.

## How the other side gets it

The download link, the file key, the name and the checksums are sent only inside the encrypted message. Neither the drop nor your cloud provider ever sees them together with the file.

The recipient's agent checks the checksum, decrypts, and saves the file into a chosen inbox folder. It never runs the file.

Links from the drop and from S3-compatible storage stop working after 7 days at most. Google Drive, Dropbox and OneDrive cannot always enforce that, so the sender's agent deletes the file and removes its link at expiry (or on receipt, if you chose that). That is best effort, and the file stays encrypted either way.

## Cleaning up (crypto-shredding)

After the file expires (the default), or once it is received if you chose that, the sender deletes the stored copy and both sides discard the key. Even a leftover copy cannot be opened. This cannot make someone who already saved the decrypted file delete it.

## Proof for files

A file send can be notarized (one flag), so you can later prove which exact file was sent and when. The public record holds only fingerprints, never the file or its name ([04 §5](../foundation/04-security-and-crypto.md)). See the [payments explainer](payments.md) for cost.

## Why not serve from the sender's disk?

The recipient may fetch while the sender's computer is off. Files need a pickup point that is always on, so local disk is never used for transfer.

## Safety

- Agents may read and write only inside folders the owner allowed, after resolving links and symlinks.
- Downloads go only to HTTPS addresses. Local, private and cloud-metadata addresses are refused (SSRF checks), and redirects are capped.
- Size limits apply before and during download.

## Read more

- Encryption, drop rules and checks: [04 §4](../foundation/04-security-and-crypto.md)
- Drop protocol and storage choice: [07 §5.4 to §5.6](../foundation/07-sdk-transport-storage.md)
- File tools and policies: [06 §2.3](../foundation/06-mcp-server.md)
- Data flow: [03 §4.2](../foundation/03-architecture.md)
- Cost: [12](../foundation/12-economics-and-fees.md)
