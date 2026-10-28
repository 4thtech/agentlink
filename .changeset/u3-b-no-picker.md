---
'@4thtech-io/agentlink': patch
---

AgentLink never asks which agent (U3-b): `agentlink ui` opens the last used agent, else the one an AI app already starts, else the first by name; `init` without `--agent` keeps D5 and otherwise uses that same current agent; bare `agentlink` opens the app. `--agent` stays under Advanced in `--help`.
