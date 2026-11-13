---
section: Added
---

- An early Windows app for Windows 10 and 11 (unsigned): each release now attaches `AgentLink-<version>-win-x64-setup.exe` and a stable-named `AgentLink-win-x64-setup.exe` (listed in `SHA256SUMS-desktop-app.txt`), the invite page offers it under Windows, and the guide says how to get past "Windows protected your PC" (More info, then Run anyway) and what to do when Smart App Control blocks it. The browser app stays the main way on Windows (WIN-DESK-1d).
- The Windows app checks its bundled files at start like the Mac app, has its own tray icon for light and dark taskbars, links the new setup file in Settings › Updates, and its setup asks you to quit AgentLink before it installs or removes it (WIN-DESK-2).
- On Windows, the app does not start when your `.agentlink` folder gives access to other people on the computer (for example Everyone or Users), and says how to fix it; the access Windows gives a folder in your user folder (you, SYSTEM and Administrators) is accepted (WIN-DESK-2, OD-M, S2).
