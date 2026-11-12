---
section: Fixed
---

- Desktop app, Touch ID for approvals (DESK-NATIVE-DEBUG, S2): turning it on no longer ends silently. The Settings card says it is waiting for Touch ID while the macOS sheet is up and shows one plain message for every outcome; the presence helper checks Touch ID can be used before it shows a sheet; a write whose read-back fails no longer leaves a half-registered item; the core writes one fixed diagnostic line per outcome (step and fixed reason only) to the app's core log. The switch is now a proper settings row with the master code prompt beneath it.
