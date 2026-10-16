---
'@4thtech-io/agentlink': minor
---

Several agents on one computer can now share one owner: `agentlink owner add-agent --agent <name>` gives a further agent its first card from the owner key already set up, with one entry of your owner code in your own terminal. `agentlink init --harness <app>` sets up one app only (`claude-code`, `codex`, `gemini-cli`, `opencode`, `antigravity`), `--harness none` creates the agent alone, and answering no to every change keeps the agent. `init` now also configures OpenCode and Antigravity, with `--config <path>` for a config file in another place.
