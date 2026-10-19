---
'@4thtech-io/chain': patch
---

M1-4d-b: `verifyProofPack` checks the signer's agent card when the pack carries one (`cardSig` by the card's `ownerEvm`, `agentEvm` = signer, not expired at the record time; else `card_invalid` or `card_expired`) and reports it as `signerCard`. Disclosed content now names its `sender` (the envelope's `from`). With a card, the sender must be the card's `agentNostr`, else the content fails `sender_mismatch`; without a card the content is `unattributed` (`sender_not_bound`). `verdict` is `verified` only for content bound to the signer (IR-M1-4d-1 M-1).
