---
section: Fixed
---

- On Windows, Show in folder opens your Inbox folder when a file's full path is too long or unusual for File Explorer to select it; the path is still passed as one argument and never through a shell (CHORE-WIN-REVEAL-ARGS, S2).
- On Windows, the Files page names a protected folder (for example `~\AppData\Roaming\Microsoft\Protect`) in its original spelling instead of lower case; which folders are refused is unchanged (CHORE-FILES-WIN-NAME-CASE, S2).
