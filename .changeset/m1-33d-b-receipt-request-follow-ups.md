---
'@4thtech-io/core': patch
'@4thtech-io/agentlink': patch
---

Receipt request follow-ups (M1-33d-b, D-109): `notarize` with `requestReceipt` on an envelope that already had a proof without a request now returns `receiptRequestNotAdded: true`, and `agentlink_notarize` and `agentlink_send` say so in the result and the summary. Two concurrent `acknowledge {type: "delivered"}` calls for one record sign one DELIVERED receipt. An inbox page reads the receipt-request flag of all its items in one read instead of one transaction per item.
