---
section: Fixed
---

- The Windows app starts its core: the core now recognises the app's private pipe on Windows and still refuses anything else; when Windows cannot provide the app's data folder, the app says so in its log instead of "another AgentLink is running" (WIN-DESK-1, S2, 08 §8). The Windows app stays a manual CI build until it passes on real hardware.
