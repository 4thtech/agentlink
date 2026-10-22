---
'@4thtech-io/node': patch
---

The SQLite agent store opens with `secure_delete = ON` (M1-7f-2; 04 §4 crypto-shredding), so deleted rows, sealed file keys among them, are zeroed on disk. `SqliteStore.readSetting` also reads `secure_delete`.
