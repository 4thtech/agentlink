---
'@4thtech-io/agentlink': patch
'@4thtech-io/mcp-tools': patch
'@4thtech-io/node': patch
---

FILES-AI-2 (D-152): when a file can't be sent, the fixed texts for your AI now point to the way out: no allowed folder, a file outside it or a file not found on this computer suggest the user's Send folder (named as ~/AgentLink/Send only when it is the ID's own pinned one) or, for a small text file, send it by content with file: {name, content}. Fixed strings only; no value from the call reaches them.
