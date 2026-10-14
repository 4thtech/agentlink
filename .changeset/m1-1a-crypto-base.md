---
'@agentlink/crypto': minor
---

Add the crypto base layer: strict canonical encodings (hex, `0x` hex, base64url without padding, decimal uint256, UTF-8), SHA-256, keccak-256 and BIP-340 tagged hashes, RFC 8785 JSON canonicalisation with a strict parser, secure random bytes and a best-effort wipe helper; anything not in its exact canonical form is rejected.
