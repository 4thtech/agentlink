---
section: Fixed
---

- Windows desktop app (REL051-CID): the very first start no longer quits at once as if another copy were running (the app creates its settings folder before it checks for another copy), and its core now starts (it refused the app's private connection on Windows, so the window stayed on "Starting AgentLink…"). When the app quits at start, its log says why.
