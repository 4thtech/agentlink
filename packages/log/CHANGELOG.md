# @4thtech-io/log

## 0.4.6

### Patch Changes

- b72f9ad: W4-LIVE-STATUS (D-143): every `agentlink mcp` process, lease holder or not, keeps one MCP session row (store schema version 10: `mcp_sessions` and `mcp_last_seen`), written when it answers `initialize`, renewed every 15 s (TTL 45 s), stamped on tool calls and deleted on clean exit. The AI app id comes from `clientInfo.name` through one fixed table (else `other`); the name itself is never stored or logged (the redacting logger now drops `clientInfo`). The app host reads live rows only (TTL, this agent, a pid in 2..2^31-1 that answers signal 0), so `GET /api/ui/agents` gains `state`, `lastSeenAt` and per AI app `{app, state, since?, lastSeenAt?}`, and Running no longer comes from the publisher lease. New read `GET /api/ui/events`: a `text/event-stream` of changes only (allowlisted fields, `Last-Event-ID` replay from 64 events, `: ping` every 15 s, 4 streams per page session and 8 in all, 30 min each), behind the same gate as every `/api/ui/` read. The page's switch to the stream is U1-b.

## 0.4.5

No changes in this release.

## 0.4.4

No changes in this release.

## 0.4.3

No changes in this release.

## 0.4.2

No changes in this release.

## 0.4.1

No changes in this release.

## 0.4.0

No changes in this release.

## 0.3.0

No changes in this release.

## 0.2.0

### Patch Changes

- 9c56860: M0-8c: the redacting logger no longer over-redacts after an apostrophe in a bracketed value, reduces a JSON-escaped protocol-relative URL to its host, and redacts `upload` URL fields whole.
- 4be1e27: Proofs and logging (M1-7g-d): the logger takes an allowlist of fixed codes (`createLogger({ codes })`, `logger.withCodes()`), so a top-level `code` field keeps only listed codes and every other value stays redacted; the proof flow lists its own codes (`PROOF_LOG_CODES`). An approved `confirm` now signs its `ACCEPTED` receipt on the other side's ACCEPT record, once, under the same approval. A contact can hold at most 32 of the 256 `proof` envelopes that wait for their message (`PROOF_AWAITING_PER_CONTACT`); beyond that the envelope is dropped as `proof_unchecked`.

## 0.1.2

No changes in this release.

## 0.1.1

No changes in this release.

## 0.1.0

### Patch Changes

- 1377cb5: Harden the log redaction: values with escaped quotes, nested JSON or objects and arrays are redacted in full, with no length cap that would let the tail of a long secret through; backslash, JSON-escaped and protocol-relative URLs are reduced to their origin; the cost of the pair scanner is bounded.
