---
'@4thtech-io/node': patch
'@4thtech-io/agentlink': patch
---

New `agentlink policy allow-send-folder` (run it yourself): sets up the empty `AgentLink/Send` folder in your home folder and allows your AI to send files from it, for an agent set up before AgentLink did this on its own. Only that folder is added to your rules. `policy allow-folder` with a differently spelled path now offers the exact path instead of refusing (M1-36b-2-c).
