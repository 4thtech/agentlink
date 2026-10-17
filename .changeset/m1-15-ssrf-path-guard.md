---
'@agentlink/core': patch
'@agentlink/node': patch
---

M1-15: SSRF-safe download (DNS-pinned, at most 2 re-checked redirects, byte cap, deadline), allowed-folder path guard with realpath on both sides, and a download file-name sanitiser. Not wired into any tool yet.
