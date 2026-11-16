---
'@4thtech-io/node': patch
'@4thtech-io/agentlink': patch
---

TRAY-PIPE: the desktop app's core tells its shell what the menu bar icon shows over the private pipe: `tray-state` (connecting, connected, paused or offline, with the unread and approvals counts), `tray-pulse` (a message in, your AI sent a message, an approval; never at startup, at most one per kind every 2 seconds) and `shell-prefs` (the menu bar switch and the app's motion setting). Fixed words, counts and booleans only: never a name, an ID or message text.
