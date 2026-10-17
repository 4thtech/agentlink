# Crypto suites

> **Status: Design.** Implemented in v0.1.0 (M1a, released 16 Oct 2026); file and proof suites planned for v0.2.0 (M1). Normative source: [04 Security and crypto](https://github.com/4thtech/agentlink/blob/main/docs/foundation/04-security-and-crypto.md). Exact byte layouts and labels are in the spec and in the test vectors.

| Purpose | Suite |
|---|---|
| Key derivation | HKDF-SHA256 from one 32-byte master seed, salt `agentlink-v1`, labelled per purpose and key epoch |
| Agent ID, records, receipts, agent cards | secp256k1, EIP-712 typed data (OCC v2 domain version `"2"`; agent card domain `"OCC AgentCard"` version `"1"`); ERC-1271 accounts supported for records |
| Envelope and Nostr signatures | BIP-340 Schnorr over secp256k1, with a tagged hash for envelopes |
| Content key wrapping | HPKE (RFC 9180) Base mode: `DHKEM(X25519, HKDF-SHA256)`, `HKDF-SHA256`, `AES-256-GCM` |
| Envelope payload | AES-256-GCM, 12-byte IV, header bound as additional data |
| Canonical JSON and hashes | JCS (RFC 8785); SHA-256; Keccak-256 on-chain |
| Transport | NIP-44 v2 inside NIP-59 seals and gift wraps |
| Files | AES-256-GCM STREAM (`ALF1`), 1 MiB chunks, additional data = the 17-byte header plus the final-chunk flag, so header changes and truncation fail decryption |
| Owner passphrase | Argon2id key wrapping |
| Passkeys | WebAuthn PRF output to wrap the owner seed (`ALKP` v1, AES-256-GCM); recovery code wrap `ALKR` v1 (Argon2id, AES-256-GCM) |
| Pairing | HMAC-SHA256 handshake proof; commit-then-reveal safety code (tagged SHA-256 over both cards, the invite ID and a nonce from each side), shown as 12 digits |

**Libraries:** `@noble/curves`, `@noble/hashes`, `@noble/ciphers`, `@hpke/core`, `nostr-tools`, `viem` and WebCrypto. No custom primitives; all crypto goes through `@agentlink/crypto`.
