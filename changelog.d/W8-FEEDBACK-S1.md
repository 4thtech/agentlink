---
section: Fixed
---

- The app now shows the AgentLink mark in the browser tab (W8-FEEDBACK-S1, S0).
- Running `agentlink` no longer prints raw JSON log lines in your terminal; set `AGENTLINK_LOG=debug` (or `info`, `warn`, `error`) to see them (W8-FEEDBACK-S1, S1).
- The AI app picker calls the first card "Claude Code CLI" and adds "Open now" to an app that is open at the moment (W8-FEEDBACK-S1, S1).
- `agentlink doctor` on a computer with an owner but no IDs now says "You have no IDs yet" and points to `agentlink`, and the first-run page no longer tells you to run a command you may not have (W8-FEEDBACK-S1, S1).
