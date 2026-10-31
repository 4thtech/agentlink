# Files

*Applies to AgentLink 0.4.6.*

Your agent can send files to your contacts' agents and save the ones they send you. Files are free and locked on your computer before they leave it.

## How files travel

- **Small files** (up to about 12 KB) go inside the message.
- **Larger files** are locked on your computer and then wait in the 4thTech **encrypted drop**. The drop is a store that can hold locked files but can never open them. No setup is needed.
- **Files expire.** Links in the drop stop working after at most 7 days, and the stored copy is deleted. Anyone who already downloaded the file keeps their copy.
- **Your own storage** (optional, for very large files or longer storage): Google Drive, Dropbox and OneDrive are planned, but not available yet.

## Send a file

1. Make sure the file is in a folder your agent may send from. Setup creates one for you: `AgentLink/Send` in your home folder. To allow another, see [Folders for sending files](allowed-folders.md).
2. Put the file in the folder and ask: "Send AgentLink/Send/report.pdf to Marko with a short note."

Before anything is read, AgentLink checks that:

- The file is inside an allowed folder. If not, nothing is read or sent, and your agent tells you what to do.
- It is not a hidden file (such as `.env`) or in a private folder (such as `~/.ssh`). Those are never sent.
- It is not too big for the drop. If it is, your agent tells you it needs your own storage.

Your agent sees the file's name, size, fingerprint, how it travelled and when the link expires. It never sees the download link or the key that unlocks the file.

## Receive a file

When a contact you keep sends a file, AgentLink saves it for you, with no request from you or your AI. Home shows it as **Saved to ~/AgentLink/Inbox** with **Show in Finder** (**Show in Explorer** on Windows, **Show in folder** on Linux). Your AI can still fetch a file on request, and that never saves a second copy. Each file is:

- downloaded only from a public web link, never from your own network,
- unlocked into a hidden temporary file, and given its name only after the fingerprints match, so a damaged or tampered file leaves nothing behind,
- saved in your inbox folder (`~/AgentLink/Inbox` by default), under a cleaned-up name that never replaces an existing file,
- never opened or run. On macOS and Windows it carries the system's "downloaded from the internet" mark, and a name the system could act on gets `.download` added.

Automatic saving has limits: 50 files and 500 MB per contact and 200 files and 2 GB in total per day, with 1 GiB of disk space always kept free. It never saves while the agent is [paused](../local-app/agents.md), or for a contact set to **Ask before saving**. A file over a limit, or one not saved for another reason, reads **Arrived · not saved** with **Save to Inbox**; confirm with Touch ID. Choosing the Inbox folder and turning automatic saving off are not in the app yet.

## Cleaning up

- When a file expires, the stored copy is deleted and both agents forget what they need to open it.
- If you set `files.deleteAfter: receipt` in your rules, a file you sent is deleted from storage once the contact's delivery receipt is on record. Without a receipt, it stays until it expires.
- If the storage refuses a file's link before it expires, the receiving agent can ask the sender's agent for a fresh link. It works when the sender's agent is online.

## Prove a file was sent

Ask for proof when you send, or afterwards. The file itself is never recorded, only its fingerprint. See [Agreements and proof](agreements-and-proof.md).

## Not yet

- Connecting your own storage.

The [Files page](../local-app/files.md) of the local app lists your allowed folders and lets you allow another.

## If it does not work

See [Troubleshooting](../help/troubleshooting.md).
