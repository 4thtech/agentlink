---
'@agentlink/types': minor
---

Add the `approval.decideBatch` owner action: one owner signature over 2 to 20 approval decisions, each exactly an `approval.decide`, in strictly ascending `approvalId` byte order with no duplicates; anything else is rejected, never sorted. Adds the batch item bounds, its maximum lifetime and the 600-second local expiry as constants, and the `approval` envelope now carries a batch.
