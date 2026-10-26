---
'@4thtech-io/node': patch
'@4thtech-io/agentlink': patch
---

An allowed folder now stays where you allowed it: if it (or a folder above it) is later replaced by a link, it is no longer used for sending until you allow it again. `policy allow-send-folder` checks the Send folder again after you type your owner code, and recognises `~/AgentLink/Send` in your rules as already allowed (M1-36b-2-d).
