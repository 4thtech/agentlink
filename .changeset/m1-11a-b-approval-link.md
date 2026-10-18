---
'@4thtech-io/agentlink': patch
---

M1-11a-b: `agentlink mcp` starts the local approval page on demand and puts its link in `pending_approval` results, next to the `agentlink approve` command. The link holds no secret: the owner's browser is opened with a one-shot session link, and approving still needs the owner code or passkey. Every tool that can ask for approval tells the AI to show the link to the user and never open or fetch it.
