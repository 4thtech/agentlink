---
'@4thtech-io/node': patch
'@4thtech-io/agentlink': patch
---

One AgentLink, browser or app: inside the desktop app no owner prompt uses a passkey (its own Touch ID / Windows Hello, else the master code); the app takes over a running `agentlink ui` host and clears a stale `app-host.json`; terminal `agentlink ui` shows a running app instead of starting a second host; a connect made inside the app writes the app form; a master-code finish with a body counts as a failed try (APP-CONTINUITY).
