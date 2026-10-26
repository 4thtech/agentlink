---
'@4thtech-io/agentlink': patch
---

`init` and `ui` on a computer with more than one agent now list the agent names and, in your own terminal, let you pick one by number, instead of a message that named none (M1-UX-MULTI-AGENT). `ui` no longer says AgentLink isn't set up when the real reason is more than one agent. When an app already has a different `agentlink` entry, `init` now says what differs (another agent name, or another way of starting AgentLink) and how to replace it.
