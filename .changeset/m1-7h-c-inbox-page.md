---
'@agentlink/core': minor
---

Add `InboxService.page(query)` (`client.inbox.page`), the inbox page read of 06 §2.2: received messages, accepted requests (D-72, with the sender code and no name) and, with `includeSent`, our own sent messages, per contact or across all contacts, ordered by (`createdAt`, envelopeId bytes), with `limit` 1 to 100, `before`, `since`, `includeRead` and a caller byte bound. The returned unread inbound items are marked read in the transaction that commits the page. New client option `dropOrigins`; new error codes `inbox_query_invalid` and `inbox_busy`.
