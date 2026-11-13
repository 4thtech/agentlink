---
section: Added
---

- "Use the app for …" on the AI apps page (WP-D7, S2, 04 §2.5, 06 §7): when the AgentLink desktop app is on this computer, an AI app connected with `npx` can start AgentLink from the app instead (`<app>/node/bin/node <app>/core/…/agentlink.js mcp`; on Windows `node.exe` itself, no `cmd /c`). The sheet shows the entry before and after, and optionally the installer's `agentlink` command; nothing is written until you confirm with Touch ID or the backup code. Entries AgentLink did not write are never touched, the `npx` form is still recognised, and an app running from a translocated, temporary or read-only place is refused ("move it to your Applications folder").
