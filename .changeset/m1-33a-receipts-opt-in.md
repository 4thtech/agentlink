---
'@4thtech-io/types': patch
'@4thtech-io/core': patch
'@4thtech-io/agentlink': patch
---

M1-33a (D-109): delivery receipts are off by default. `@4thtech-io/types`: the 06 §3 default `receipts.autoDelivered` is `false`; a `ContactRule` may carry `receipts: {autoDelivered}` (strict) with or without `proofs`, and needs at least one of the two. `@4thtech-io/core`: an automatic DELIVERED receipt uses the record signer's contact rule when that contact is paired and not blocked or revoked, else the global value; under failing rules none is signed. OPENED, ACCEPTED and REJECTED are unchanged. `@4thtech-io/agentlink`: the rules review lists a contact's delivery-receipt rule. A policy signed earlier keeps its value.
