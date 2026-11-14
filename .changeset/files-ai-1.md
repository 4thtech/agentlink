---
'@4thtech-io/agentlink': patch
'@4thtech-io/core': patch
'@4thtech-io/mcp-tools': patch
'@4thtech-io/node': patch
---

FILES-AI-1 (D-152): `agentlink_send` takes `file: {name, content}`, so an AI that wrote a small text file (.md, .markdown, .txt or .json, up to 8 MB) can send it without access to the user's folders. AgentLink saves it into the root of the ID's own Send folder with the Attach writer (never overwriting, never through a link, `notes (2).md` on a clash) and sends the bytes it was given through the ordinary encrypted send. At most 50 files and 64 MB a day per ID; refusals are fixed codes (`FILE_NAME`, `FILE_TYPE`, `FILE_NOT_TEXT`, `FILE_TOO_LARGE`, `FILE_NAME_TAKEN`, `SEND_FOLDER_UNAVAILABLE`, `FILE_BUDGET`). The local store moves to schema version 16 (the budget ledger: times and byte counts only).
