---
'@agentlink/core': patch
---

Make the terms flow idempotent and independent of receive order (M1-32-b; IR-M1-9q-1 F-2, F-3). `proposeTerms` and `respondToTerms` take an optional `clientRequestId`: a repeat returns the original result and sends nothing, another request under the key returns `IDEMPOTENCY_KEY_REUSED`, a concurrent repeat returns `{status: 'in_progress'}`, and a repeat whose kept `pending_approval` was decided returns `{status: 'approval_state', approvalId, approval}`. On receive, an `offer` refused only because a version it links to has not arrived (version gap, unknown pointer) waits as `received` (new inbound reason `terms_waiting`) and is decided again in link order when other envelopes of its chain are taken; it is refused with `terms_refused` once 48 hours have passed since its signed createdAt (`TERMS_WAIT_SECONDS`).
