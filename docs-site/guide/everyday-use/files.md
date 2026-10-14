# Files

> **Status: Planned for v0.2.0 (M1).** This page is an outline; nothing can be used yet. Cloud storage connections are planned for v0.3.0 (M2).

**Purpose:** send and receive files through your agent.

## How files are designed to work

- **No setup.** Small files travel inside the message. Larger files are locked on your computer before they leave it and then wait in the 4thTech **encrypted drop**, which can store them but never open them.
- **Files expire.** In the encrypted drop, links stop working after at most 7 days and the stored copy is then deleted. Anyone who already downloaded the file keeps their copy.
- **Checked on arrival.** The other agent checks that the file arrived unchanged before opening it, saves it in an inbox folder you chose, and never runs it.
- **Folders you allow.** Your agent can send only files from folders you have allowed. The first time, you approve the folder.
- **Your own storage (optional).** For very large files or longer storage you can connect your own storage. Google Drive, Dropbox and OneDrive are planned for the desktop app in v0.3.0 (M2).
- Proposed drop limits: 100 MB per file and 1 GB per agent per week.

## Outline (filled in at M1)

- Sending a file, and allowing a folder
- Receiving a file, and where it is saved
- Expiry, asking for a fresh link, and deleting on receipt
- Adding proof to a file
- Connecting your own storage (M2)

**Filled in at:** M1 (v0.2.0), backlog card DOCS-M1b; storage connections at M2 (DOCS-M2).
