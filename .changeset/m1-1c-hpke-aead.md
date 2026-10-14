---
'@agentlink/crypto': minor
---

Add envelope encryption: the CEK wrap with RFC 9180 HPKE (mode Base, DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-256-GCM via `@hpke/core`) with info `agentlink/v1/cek` and the raw envelope ID, an empty AAD and an explicit all-zero shared-secret check in both directions; the payload AEAD (AES-256-GCM, random 12-byte IV, AAD = sha256(JCS(header))); a strict v1 envelope parser with the 04 §3.1.1 limits (1 to 8 recipients with distinct `kid`s, `aead.ct` at most 17 152 bytes, checked on its base64url length before decoding; `MAX_RECIPIENTS`, `AEAD_CT_MAX_LENGTH`, `AEAD_CT_MAX_ENCODED_LENGTH`); `envelopeHash`; and the envelope signature input and verification under the `agentlink/envelope/v1` tag. `unwrapCek(secretKey, wrapped, envelopeId)` (it builds the HPKE info itself and takes no caller-supplied info) and `signEnvelopeHash` (it applies the envelope tag itself) are exported only from `@agentlink/crypto/keystore`. New dependency: `@hpke/core` 1.9.0.
