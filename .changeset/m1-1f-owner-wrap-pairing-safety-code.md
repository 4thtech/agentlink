---
'@agentlink/crypto': minor
---

Add the owner passphrase wrap and file KeyStore formats, the pairing proof and the safety code: Argon2id (RFC 9106) and the 04 §2.8 `password()` normalisation for generated codes and chosen passphrases, generated 120-bit codes, `ALKS` v1 seal and open (with the in-memory kek check for writes) and `ALKO` v1 owner seed seal and open (local storage only), all in `@agentlink/crypto/keystore`; and, in the main entry, HMAC-SHA256, `proofKey` and the pairing proof, `codeCommit` and its constant-time reveal check, the safety-code transcript, `pairingDigest` and the 12-digit code.
