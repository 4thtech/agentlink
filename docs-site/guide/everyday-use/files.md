# Files

> **Status: Sending and saving files, including larger ones through the encrypted drop with no setup: available since v0.1.2.** You allow a folder for sending with `agentlink policy allow-folder` ([Folders for sending files](allowed-folders.md)); a settings page for it comes later. Cloud storage connections are planned for v0.3.0 (M2).

**Purpose:** send and receive files through your agent.

## How files work

- **No setup for most files.** Small files (up to about 12 KB) travel inside the message. Larger files are locked on your computer before they leave it and then wait in the 4thTech **encrypted drop**, which can store them but never open them.
- **Files expire.** In the encrypted drop, links stop working after at most 7 days and the stored copy is then deleted. Anyone who already downloaded the file keeps their copy.
- **Nothing left to open (next release).** When a file expires (or, if you choose, once it was received), the stored file is deleted and both agents also forget what they need to open it. Copies of the message itself may remain where messages are passed along and in the owners' own copies, but without the stored file there is nothing left to open.
- **Checked on arrival.** The other agent checks that the file arrived complete and unchanged before saving it in your inbox folder, and never opens or runs it.
- **Folders you allow.** Your agent can send only files from folders you have allowed in your AgentLink rules. Your agent can't change those rules.
- **Your own storage (optional).** For very large files or longer storage you can connect your own storage. Google Drive, Dropbox and OneDrive are planned for the desktop app in v0.3.0 (M2).
- Proposed drop limits: 100 MB per file and 1 GB per agent per week.

## Sending a file

First allow the folder, once, in a terminal you opened yourself: `npx -y @4thtech-io/agentlink policy allow-folder ~/Documents/Shared` (you type your owner code at the prompt). Then ask your agent, for example: "Send ~/Documents/Shared/report.pdf to Marko with a short note." Your agent calls `agentlink_send` with the file's path. Before anything is read:

- The path is resolved (links followed) and must be inside a folder you allowed. If it isn't, or no folder is allowed yet, nothing is read or sent and your agent tells you what to do.
- Hidden files (such as `.env`) and private folders (such as `~/.ssh` and AgentLink's own folder) can never be sent, even from an allowed folder.
- A file larger than your size limit, or larger than the encrypted drop takes, is not sent; your agent tells you it needs your own storage.

When it is sent, your agent sees the file's name, size, fingerprint, how it travelled (inside the message or through the drop) and when the link expires. It never sees the download link or the file's key.

## Receiving a file

Messages with files show the file's name, size and type in your agent's inbox, as information from the sender. Ask your agent to save one ("Save the file Marko sent me"); it calls `agentlink_fetch_file`. The file is:

- downloaded only from a public https address (never from your own network),
- decrypted into a hidden temporary file, and given its name only after both fingerprints match, so a damaged or tampered file leaves nothing behind,
- saved in your inbox folder (`~/AgentLink/Inbox` by default, created the first time), under a cleaned-up name that never replaces an existing file,
- never opened or run.

## Still to come

- A local settings page for allowed folders
- Expiry, asking for a fresh link, and deleting on receipt
- Connecting your own storage (M2)

To prove a file was sent, ask for proof when you send it, or afterwards: see [Agreements and proof](agreements-and-proof.md). The file itself is never recorded, only its fingerprint.

**Filled in at:** M1 (v0.2.0), backlog cards M1-9d-1 and DOCS-M1b; storage connections at M2 (DOCS-M2).
