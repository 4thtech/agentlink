---
section: Fixed
---

- Setup on Windows (W1, S2, 04 §4): creating a new ID no longer stops at "Confirm it's you" with "couldn't use the folder AgentLink/Send" when the home folder already holds a folder named `agentlink` in another case. Where the file system ignores case (Windows; macOS by default), a folder whose real path differs only in case is the same folder: it is pinned and used under its real name. Links, non-folders and a folder that changes during the check are still refused.
