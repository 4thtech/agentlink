---
'@4thtech-io/agentlink': patch
---

In the desktop app, turning Touch ID for approvals on or off now always says what happened: it shows that it is waiting for Touch ID, gives a plain message for every outcome (cancelled, not recognised, not available right now, timed out, keychain, busy), checks the sensor before showing a sheet, and writes one fixed line per outcome to the app's core log. The Settings switch is its own settings row with the master code prompt beneath it. (DESK-NATIVE-DEBUG)
