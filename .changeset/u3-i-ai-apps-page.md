---
'@4thtech-io/types': patch
'@4thtech-io/agentlink': patch
---

U3-i: the AI apps page of the local app (b11 §30, 08 §1). One card per detected AI app with a state read from the app's own settings (Connected to {agent}, Connected to another agent, Not connected, Running, Quit {app} first), the exact AgentLink entry shown before Touch ID, then apply, move to another agent, or disconnect, with manual steps as a fallback. The Agents page, the switcher and Start here now show each agent's AI app by name (the list holds app ids). Shared wire samples for the AI apps routes in `@4thtech-io/types/ui-contract/apps`.
