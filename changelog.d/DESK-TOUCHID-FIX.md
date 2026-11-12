---
section: Fixed
---

- Desktop app, Touch ID for approvals (DESK-TOUCHID-FIX, S2): before any request that starts the presence helper (approve, rules, recovery kit, turning it on), the page takes focus off the master code field and the app window takes focus off the page, so macOS secure input is off when the Touch ID sheet appears; the core writes one fixed line if secure input was still on. While waiting the app says "Rest your finger on the Touch ID key" with a Cancel. The helper now handles SIGTERM and SIGINT by closing its Touch ID prompt and exiting as cancelled, and the core stops a cancelled or timed-out helper with SIGTERM and waits for it to exit.
