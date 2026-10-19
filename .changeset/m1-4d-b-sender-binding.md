---
'@4thtech-io/chain': patch
---

M1-4d-b: `verifyProofPack` checks the signer's agent card when the pack carries one (`cardSig` by the card's `ownerEvm`, `agentEvm` = signer and ≠ `ownerEvm`, not expired at the record time; else `card_invalid` or `card_expired`) and reports it as `signerCard`. Disclosed content names its `sender` (the envelope's `from`). With a card, the sender must be the card's `agentNostr`, else the content fails `sender_mismatch`. Content that opens is `unattributed`: `sender_not_bound` without a card, `sender_attribution_pending` with one (interim rule: `verdict` stays `record_only`; full sender attribution is in development, M1-4d-d).
