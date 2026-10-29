---
'@4thtech-io/agentlink': patch
'@4thtech-io/node': patch
---

The local app finishes a pairing it accepted when no AI app is running (U3-invite-b, 06 §6, 08 §4): while the join screen waits for the inviter's answer, the app takes the agent's publisher lease only when no other process holds it, runs one short catch-up pass and releases it, so the screen moves on to "Connected with {name}." With an AI app's AgentLink server running, the app leaves the work to it.
