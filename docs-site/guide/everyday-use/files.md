# Files

> **Status: In the next release (not in v0.1.1).** Sending and saving files through your agent is built and comes with the next release. Two things are still missing before most people can use it: a command or settings page to allow a folder for sending (until then, no folder is allowed, so your agent can't send files yet), and the encrypted drop for files above about 12 KB, which is built but not running yet. Cloud storage connections are planned for v0.3.0 (M2).

**Purpose:** send and receive files through your agent.

## How files work

- **No setup for most files.** Small files (up to about 12 KB) travel inside the message. Larger files are locked on your computer before they leave it and then wait in the 4thTech **encrypted drop**, which can store them but never open them.
- **Files expire.** In the encrypted drop, links stop working after at most 7 days and the stored copy is then deleted. Anyone who already downloaded the file keeps their copy.
- **Nothing left to open (coming soon).** When a file expires (or, if you choose, once it was received), the stored file is deleted and both agents also forget what they need to open it. Copies of the message itself may remain where messages are passed along and in the owners' own copies, but without the stored file there is nothing left to open.
- **Checked on arrival.** The other agent checks that the file arrived complete and unchanged before saving it in your inbox folder, and never opens or runs it.
- **Folders you allow.** Your agent can send only files from folders you have allowed in your AgentLink rules. Your agent can't change those rules.
- **Your own storage (optional).** For very large files or longer storage you can connect your own storage. Google Drive, Dropbox and OneDrive are planned for the desktop app in v0.3.0 (M2).
- Proposed drop limits: 100 MB per file and 1 GB per agent per week.

## Sending a file (next release)

Ask your agent, for example: "Send ~/Work/report.pdf to Marko with a short note." Your agent calls `agentlink_send` with the file's path. Before anything is read:

- The path is resolved (links followed) and must be inside a folder you allowed. If it isn't, or no folder is allowed yet, nothing is read or sent and your agent tells you what to do.
- Hidden files (such as `.env`) and private folders (such as `~/.ssh` and AgentLink's own folder) can never be sent, even from an allowed folder.
- A file larger than your size limit, or larger than the encrypted drop takes, is not sent; your agent tells you it needs your own storage.

When it is sent, your agent sees the file's name, size, fingerprint, how it travelled (inside the message or through the drop) and when the link expires. It never sees the download link or the file's key.

## Receiving a file (next release)

Messages with files show the file's name, size and type in your agent's inbox, as information from the sender. Ask your agent to save one; it calls `agentlink_fetch_file`. The file is:

- downloaded only from a public https address (never from your own network),
- decrypted into a hidden temporary file, and given its name only after both fingerprints match, so a damaged or tampered file leaves nothing behind,
- saved in your inbox folder (`~/AgentLink/Inbox` by default, created the first time), under a cleaned-up name that never replaces an existing file,
- never opened or run.

## Still to come

- Allowing a folder for sending (the `agentlink policy` command and the local settings page)
- Expiry, asking for a fresh link, and deleting on receipt
- Adding proof to a file
- Connecting your own storage (M2)

**Filled in at:** M1 (v0.2.0), backlog cards M1-9d-1 and DOCS-M1b; storage connections at M2 (DOCS-M2).
