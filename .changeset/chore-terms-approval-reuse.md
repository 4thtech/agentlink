---
'@4thtech-io/core': patch
---

Terms: one approval reports `ok` to one request only. A later or concurrent call with the same `approvalId` under another request returns `APPROVAL_USED` with the original envelope, also while that accept is still waiting for relay acknowledgements; a repeat of the same `clientRequestId` still returns its original result (04 §3.4.2).
