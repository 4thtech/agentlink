---
'@4thtech-io/agentlink': patch
'@4thtech-io/node': patch
---

M1-36a-b: every "run this" line in `init`, `doctor`, the owner commands, the not-set-up message, the approval page and the owner setup steps now starts with a command that works on your computer: `agentlink` only after a global install, otherwise `npx -y @4thtech-io/agentlink`. The approval page no longer points to `agentlink ui`, which does not exist; it names `approve` instead. When your AI checks AgentLink on a computer that has no owner yet, it now tells you to run `owner init` instead of `owner add-agent`.
