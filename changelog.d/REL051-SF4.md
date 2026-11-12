---
section: Security
---

- The app's one-time sign-in link no longer appears in the browser-opening command, where other people signed in to the same computer could read it; the app opens through a private file in your own AgentLink folder instead (REL051-SF4, S2, 04 §2.8, 08 §1).
- The local app server: only a request from your open app keeps it running, and a request with a wrong handoff token can no longer hold back a real `agentlink join` (REL051-SF4, 08 §1, §4).
- Dismissing the auto-save notice and marking a former name as seen are now writes with the full write checks instead of reads (REL051-SF4, 08 §1).
- Received files of more Windows types that run, install or open as a drive on double-click (for example `.com`, `.cpl`, `.jar`, `.reg`, `.iso`, `.vhd`) are saved with `.download` at the end (REL051-SF4, 04 §4.1; proposed, owner confirms at merge).
- Owner steps such as `agentlink ui` and `agentlink join` are refused in the terminals of more AI apps (OpenCode, Cursor, Antigravity, and apps that set `AI_AGENT`), so your master code is never shown to an AI (REL051-SF4, 04 §2.8).
