---
'@4thtech-io/agentlink': patch
---

M1-9m-b: `agentlink policy allow-folder` refuses a folder that contains a protected folder (D-99), naming it and asking for a narrower folder, compared by realpath and ignoring case. New owner command `agentlink policy recover` (D-100) repairs rules that fail closed: it shows only the kind of failure, the stored rules (when their signature verifies) or the defaults in full, and signs a complete policy after an explicit `y` and the owner code. `agentlink doctor` names it when the rules fail closed.
