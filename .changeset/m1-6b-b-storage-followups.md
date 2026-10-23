---
'@4thtech-io/storage': patch
---

Storage follow-ups (M1-6b-b): the lifecycle update re-reads before writing and checks the result, errors thrown by a caller's stream surface as a fixed StorageError, and an upload whose create or complete answer was lost is aborted or its object removed.
