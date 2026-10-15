---
'@agentlink/core': minor
'@agentlink/types': minor
---

Add `ApprovalService.read(approvalId)` and `ApprovalService.countPending()` in `@agentlink/core` (M1-7e-3): one approval's state for its own stored action, with the stored owner decision and cancel re-verified against the recomputed action digest before the status cache is read (`pending`, `approved`, `denied`, `cancelled`, `expired`, `used`, `void`, or `unknown` with `not_found` or `invalid` for a row that does not verify), and the number of approvals waiting for the owner. The result never carries the owner signature, the decision payload, the action or the summary, and reading never changes a row. `OwnerActions.readApproval` backs it. In `@agentlink/types`, a `pending_approval` result no longer requires `url` (06 §2.5: none in M1a), and `getApprovalResultSchema` accepts `used: true` on an `expired` approval.
