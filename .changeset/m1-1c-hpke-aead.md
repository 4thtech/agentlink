---
'@agentlink/crypto': minor
---

Add envelope encryption: the CEK wrap with RFC 9180 HPKE (mode Base, DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-256-GCM via `@hpke/core`) with info `agentlink/v1/cek` and the raw envelope ID, an empty AAD and an explicit all-zero shared-secret check in both directions; the payload AEAD (AES-256-GCM, random 12-byte IV, AAD = sha256(JCS(header))); a strict v1 envelope parser; `envelopeHash`; and the envelope signature input and verification under the `agentlink/envelope/v1` tag. `unwrapCek` and `signEnvelopeHash` are exported only from `@agentlink/crypto/keystore`. New dependency: `@hpke/core` 1.9.0.
