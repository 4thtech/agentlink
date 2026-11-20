---
'@4thtech-io/node': patch
---

Opening a store runs all pending schema steps in one transaction: a new store is created in one commit, an older one is upgraded in one commit, and a failed upgrade leaves the store at its old version. A new store gets incremental auto_vacuum before its switch to WAL, so its first open no longer runs a VACUUM (STORE-CREATE-ONE-TX).
