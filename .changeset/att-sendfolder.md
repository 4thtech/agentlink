---
'@4thtech-io/agentlink': patch
'@4thtech-io/node': patch
'@4thtech-io/mcp-tools': patch
'@4thtech-io/local-ui': patch
---

ATT-SENDFOLDER-FIX + ATT-ALLOW-LINK: an existing ~/AgentLink/Send that already holds files is used for a new ID (the owner is told), an unusable one falls back to a fresh Send-2 in the app, Home offers "Allow Send folder" when an ID allows no folder, and the AI's no-folder answer links to Settings > Files with the Send folder filled in instead of a terminal command.
