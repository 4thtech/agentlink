---
'@4thtech-io/agentlink': patch
---

W5-WINDOWS: on Windows, `init` and the app write the AI app entry as `cmd /c npx …` for every app (Codex included), so apps that cannot start `npx.cmd` directly can start AgentLink. Entries written earlier in the old form are still recognised and move to the new form on the next write.
