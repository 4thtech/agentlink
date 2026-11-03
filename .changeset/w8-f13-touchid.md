---
'@4thtech-io/agentlink': patch
---

W8-F13-TOUCHID: the local app's New ID gate reads `GET /api/owner/passkey` and, when the owner has no passkey on this computer and the server gives the switch values, offers "Switch to Touch ID" first: the backup code once registers the passkey through the existing switch (`POST /api/owner/passkey`), then the ID is created with its own touch. The backup-code form says what the backup code is and why Touch ID isn't offered, spaces its field and buttons, and shows one Back in Get started. No server or protocol change.
