---
'@4thtech-io/agentlink': patch
---

In the desktop app, Touch ID for approvals is more robust: the master code field loses focus before the Touch ID sheet is asked for (so macOS secure input does not keep the sheet from becoming active), the app shows "Rest your finger on the Touch ID key" with a Cancel while it waits, and a cancelled or timed-out prompt is closed instead of being left on screen. The core log notes, as one fixed line, when secure input was still on. (DESK-TOUCHID-FIX)
