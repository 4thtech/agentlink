---
'@4thtech-io/types': patch
'@4thtech-io/core': patch
'@4thtech-io/node': patch
'@4thtech-io/agentlink': patch
---

M1-33a (D-109): delivery receipts are off by default. `@4thtech-io/types`: the 06 §3 default `receipts.autoDelivered` is `false`; a `ContactRule` may carry `receipts: {autoDelivered}` (strict) with or without `proofs`, and needs at least one of the two. `@4thtech-io/core`: an automatic DELIVERED receipt uses the record signer's contact rule when that contact is paired and not blocked or revoked, else the global value; under failing rules none is signed. OPENED, ACCEPTED and REJECTED are unchanged. `@4thtech-io/core` also adds `receiptsOnFromOlderDefault` and `recordReceiptsKept` on `OwnerActions` and the `receiptsKept` client option (a `ReceiptsKeptMark`). `@4thtech-io/node`: the receipts-kept marker as the keychain item `<agentId>:receipts-kept`, on `AgentStore.receiptsKept`. `@4thtech-io/agentlink`: the rules review lists a contact's delivery-receipt rule; a policy signed earlier keeps its value until the owner next signs their rules, which then asks "Keep delivery receipts on?" and turns them off unless the owner types y (a yes is remembered); until then `agentlink doctor` shows the older-default line.
