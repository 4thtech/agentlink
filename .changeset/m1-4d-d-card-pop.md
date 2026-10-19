---
'@4thtech-io/chain': patch
'@4thtech-io/types': patch
---

M1-4d-d: proof packs may carry the signer card's proof of possession, `signer.cardAgentSig` (agent EVM key, EIP-712 over the card) and `signer.cardPop` (BIP-340 by the card's `agentNostr` over `taggedHash("agentlink/card-pop/v1", sha256(JCS(card)))`), together and only with `agentCard` (else `malformed_pack`). `verifyProofPack` checks both after the card checks: either one that does not verify over this exact card fails the pack with `card_pop_invalid`; with both valid and an ECDSA signer, content that passes every step is `verified` and so is the verdict. A card without them, or a contract-account signer, keeps the content `unattributed` with `card_pop_missing`, which replaces `sender_attribution_pending`.
