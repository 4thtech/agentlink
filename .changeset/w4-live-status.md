---
'@4thtech-io/core': patch
'@4thtech-io/log': patch
'@4thtech-io/types': patch
'@4thtech-io/node': patch
'@4thtech-io/agentlink': patch
---

W4-LIVE-STATUS (D-143): every `agentlink mcp` process, lease holder or not, keeps one MCP session row (store schema version 10: `mcp_sessions` and `mcp_last_seen`), written when it answers `initialize`, renewed every 15 s (TTL 45 s), stamped on tool calls and deleted on clean exit. The AI app id comes from `clientInfo.name` through one fixed table (else `other`); the name itself is never stored or logged (the redacting logger now drops `clientInfo`). The app host reads live rows only (TTL, this agent, a pid in 2..2^31-1 that answers signal 0), so `GET /api/ui/agents` gains `state`, `lastSeenAt` and per AI app `{app, state, since?, lastSeenAt?}`, and Running no longer comes from the publisher lease. New read `GET /api/ui/events`: a `text/event-stream` of changes only (allowlisted fields, `Last-Event-ID` replay from 64 events, `: ping` every 15 s, 4 streams per page session and 8 in all, 30 min each), behind the same gate as every `/api/ui/` read. The page's switch to the stream is U1-b.
