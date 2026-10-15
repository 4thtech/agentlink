---
'@agentlink/core': patch
---

`inbox.counts()` now counts only unread messages of the types an inbox page returns (`PAGE_TYPES`), so a received `proof` or protocol-type envelope no longer leaves an unread count that no inbox read clears (IR-M1-7h-c-1).
