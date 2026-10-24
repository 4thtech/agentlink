---
'@4thtech-io/node': patch
---

Groundwork for backup and restore, with no user commands yet (M1-9i-c): the keychain and file backends implement the recovery-kit export and import controls and the storage credential control, with the restore quarantine and its snapshot checks, the own-storage items on the agent store, and a refusal of a nested inter-process lock in the same flow. Not reachable from the package entry yet; the CLI owner commands wire them (M1-9i).
