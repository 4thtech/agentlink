---
'@4thtech-io/core': patch
'@4thtech-io/node': patch
---

When your AI fetches a received file, the local store now remembers the name it was saved under in your Inbox folder, encrypted like the file's other details (MSG-FILES-IO-b), so the local app can show which received files are saved. Store schema version 6 adds `files.saved_name`; the SQLite store migrates automatically and existing files read "not saved yet". Migrations are forward-only: once a store is at version 6, an older AgentLink refuses to open it (`store_schema_newer` / `store_too_new`), so you cannot roll the package back after upgrading.
