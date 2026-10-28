---
'@4thtech-io/node': patch
'@4thtech-io/agentlink': patch
'@4thtech-io/local-ui': patch
---

U3-c: `agentlink ui` becomes the app host (D-138, 08 §1). It serves one agent at a time and switches to another of your agents in the same window, port and session (`POST /api/ui/agents/switch`, a new named route kind `switch` with no owner presence that signs nothing and writes only `~/.agentlink/app.json`). `GET /api/ui/agents` lists every agent on this computer, including ones made by older versions, with its label, contact count, whether an AI app is running it and whether its removal is unfinished. Every answer carries a generation number and the open agent's label; every change the page sends carries the generation and is refused with `agent_changed` when another agent was opened meanwhile, so the page reloads for the agent that is open. Every process that opens an agent now holds a shared lock on its folder. The other U3 routes are registered as stubs answering `not_available` until their cards land.
