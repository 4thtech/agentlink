---
'@agentlink/core': minor
'@4thtech-io/agentlink': minor
---

Fresh sessions can find open offers and finish approved actions (M1-22). Core adds `TermsService.openOffers()` (received offers still waiting for an answer, read from the store: newest open version, from an active contact, not accepted, not rejected by this agent, not expired), `ApprovalService.resumeOf(approvalId)` (the tool and only its structured, re-verified args while the agent still has something to run) and an `envelopeIds` filter on the inbox page. `agentlink_status` adds `openOffers` and `offers` (counts by contact) and a summary line; `agentlink_inbox` takes `openOffers: true` to list them, read ones included; `agentlink_get_approval` adds `action` (tool, and for a terms accept or reject the `envelopeId` and `decision`) and, once approved, a `nextStep` that says how to finish.
