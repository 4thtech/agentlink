---
section: Security
---

- Security rules for removing an agent and connecting AI apps from the app (U3-spec-04, S2, 04 §2.3.3, §2.5, §2.5.1, §2.8; D-138; proposed, owner confirms at merge): naming an agent and connecting or disconnecting an AI app are signed owner actions that last 10 minutes and never leave the computer; removing an agent always retires it for good, tells its contacts when it has any, erases only that agent's keys and can never be undone by a restore; AI app configs are written only with the fixed AgentLink entry, at fixed paths, with a backup, showing only the AgentLink entry; switching agents never mixes their keys and every approval names the agent.
