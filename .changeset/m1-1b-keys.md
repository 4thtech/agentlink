---
'@agentlink/crypto': minor
---

Add key derivation and public identities: HKDF-SHA256 and the exact 04 §2.1 derivation of the evm, nostr, enc and drop keys (secp256k1 rejection loop, the EVM key only at epoch 0), the agent ID as a lowercase `0x` address with an EIP-55 display form, the X25519 key and its `kid`, a public identity bundle that never carries the drop key, BIP-340 sign and verify helpers, and owner and agent fingerprints with their display forms. Functions that take a master seed or a secret key are exported only from the restricted subpath `@agentlink/crypto/keystore`; the main entry keeps public keys, verification and fingerprints.
