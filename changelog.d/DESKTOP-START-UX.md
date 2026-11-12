---
section: Fixed
---

- DESKTOP-START-UX: the desktop app (preview, not released) now opens its window at once with "Starting AgentLink…", and when it can't start it says why in the window (not set up, keychain, address in use, stopped several times, started by an AI app, missing files) with Try again and Open log folder; the menu-bar / tray item is always there; the background part's error output is kept, with links and long codes removed, in a private log file (macOS `~/Library/Logs/AgentLink/core.log`, Windows `%LOCALAPPDATA%\AgentLink\logs\core.log`).
