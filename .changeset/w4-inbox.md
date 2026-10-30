---
'@4thtech-io/types': patch
'@4thtech-io/core': patch
'@4thtech-io/node': patch
'@4thtech-io/agentlink': patch
---

W4-INBOX, W4-FILES-SAVE: the local app's Inbox page (Needs you, conversations with messages and files inline, approvals as cards with inline Touch ID, All caught up) and "Save to Inbox" for a received file: one Touch ID signs a local `file.save` owner action, and core saves the file into the Inbox folder with its own fetch (local decrypt, no path from the page).
