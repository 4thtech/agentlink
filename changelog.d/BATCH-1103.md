---
section: Fixed
---

- Claude Code run in the Claude desktop app's Code tab now shows as "Claude Code" in live status instead of "Another AI app" (F46, S1; the app announces itself as `local-agent-mode-<server>`).
- `agentlink doctor` copy (D1/D3, S1): it never tells you to run an `owner add-agent` command, it points to the AgentLink app in plain words; without `--id` it checks every ID on the computer by its display name, lists the AI apps that start it and ends each block with an OK or Problem line; an AI app that starts a removed ID names the app and the ID and says how to fix it in the app.
