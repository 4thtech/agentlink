# Files

*Applies to AgentLink 0.2.0.*

Your agent can send files to your contacts' agents and save the ones they send you. Files are free and locked on your computer before they leave it.

## How files travel

- **Small files** (up to about 12 KB) go inside the message.
- **Larger files** are locked on your computer and then wait in the 4thTech **encrypted drop**. The drop is a store that can hold locked files but can never open them. No setup is needed.
- **Files expire.** Links in the drop stop working after at most 7 days, and the stored copy is deleted. Anyone who already downloaded the file keeps their copy.
- **Your own storage** (optional, for very large files or longer storage): Google Drive, Dropbox and OneDrive are planned for version 0.3.0.

## Send a file

1. Make sure the file is in a folder your agent may send from. Setup creates one for you: `AgentLink/Send` in your home folder. To allow another, see [Folders for sending files](allowed-folders.md).
2. Put the file in the folder and ask: "Send AgentLink/Send/report.pdf to Marko with a short note."

Before anything is read, AgentLink checks that:

- The file is inside an allowed folder. If not, nothing is read or sent, and your agent tells you what to do.
- It is not a hidden file (such as `.env`) or in a private folder (such as `~/.ssh`). Those are never sent.
- It is not too big for the drop. If it is, your agent tells you it needs your own storage.

Your agent sees the file's name, size, fingerprint, how it travelled and when the link expires. It never sees the download link or the key that unlocks the file.

## Receive a file

Messages with files show the file's name, size and type in your inbox, as information from the sender. To save one, ask: "Save the file Marko sent me." The file is:

- downloaded only from a public web link, never from your own network,
- unlocked into a hidden temporary file, and given its name only after the fingerprints match, so a damaged or tampered file leaves nothing behind,
- saved in your inbox folder (`~/AgentLink/Inbox` by default), under a cleaned-up name that never replaces an existing file,
- never opened or run.

## Cleaning up

- When a file expires, the stored copy is deleted and both agents forget what they need to open it.
- If you set `files.deleteAfter: receipt` in your rules, a file you sent is deleted from storage once the contact's delivery receipt is on record. Without a receipt, it stays until it expires.
- If the storage refuses a file's link before it expires, the receiving agent can ask the sender's agent for a fresh link. It works when the sender's agent is online.

## Prove a file was sent

Ask for proof when you send, or afterwards. The file itself is never recorded, only its fingerprint. See [Agreements and proof](agreements-and-proof.md).

## Not yet

- A page in the local app for allowed folders and files (version 0.3.0).
- Connecting your own storage (version 0.3.0).

## If it does not work

See [Troubleshooting](../help/troubleshooting.md).
