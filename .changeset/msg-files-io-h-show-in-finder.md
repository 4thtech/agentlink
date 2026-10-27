---
'@4thtech-io/agentlink': patch
'@4thtech-io/core': minor
'@4thtech-io/node': minor
---

MSG-FILES-IO-h: Show in Finder for a saved received file in the local app ("Show in folder" on Windows and Linux), with no Touch ID (D-134). The page sends only the item's ID; the local server reads the saved name from the store (core `filesIo.savedName`), opens the file once inside the Inbox folder without following a link, checks it, and asks the OS file manager to show it (no shell). New route kind `presence: 'reveal'` for `POST /api/ui/files/received/reveal` only. The Received and Sent tabs now read the real file lists: other people's file names sit in the untrusted-content box, a malformed item is skipped instead of hiding the list, and a file that was not delivered says so.
