---
'@agentlink/crypto': minor
---

Add EIP-712 typed-data hashing, canonical secp256k1 ECDSA signatures (`0x` r‖s‖v, low `s`, v 27 or 28; every other form is refused) and the AgentCard: its type under the chain-agnostic domain, a strict parser for its JSON form, `sha256(JCS(card))`, and verification of `cardSig` and the mandatory `cardAgentSig`. The signing functions (`signDigestEcdsa`, `signTypedData`, `signAgentCard`) are in the restricted `@agentlink/crypto/keystore` subpath. `parseJson` gains an `integersOnly` option that refuses `1.0`, `1e3`, `-0` and unsafe integers on the token text.
