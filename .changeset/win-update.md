---
'@4thtech-io/agentlink': patch
---

Windows app: in-app updates work. The core now accepts the Windows setup link the app sends for a new version (`AgentLink-<version>-win-x64-setup.exe` for exactly that version), so Settings › Updates shows "Update now" instead of "Couldn't read this just now". The manual "Download the new version" card now appears only when a check failed or was offline, or the update state could not be read, never while checking, before a check, with checks off or when up to date (WIN-UPDATE-0516).
