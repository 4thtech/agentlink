---
'@agentlink/types': minor
'@agentlink/crypto': minor
---

Add the `terms` schema of 04 §3.4 (D-32, D-55): `termsSchema` with its canonical form (NFC text without control, bidi, format or private-use characters; strict amount, currency, date, hash and agent-ID spellings; `payer` and `by` among the two parties; unique deliverable ids; bounded sizes, `TERMS_LIMITS`), `TermsInput` (`termsInputSchema`, `termsInputJsonSchema`, `termsFromInput`) and the pure negotiation-chain checks (`negotiationKey`, `nextTermsLink`, `evaluateIncomingOffer`, `evaluateIncomingAnswer`, `checkSendAccept`). In `@agentlink/crypto`: `termsHash` (sha256 of the JCS form, bare hex) and `verifyTermsHash`. **BREAKING:** `offer`, `accept` and `reject` bodies and the commitment approval context now require strict canonical `terms`, and the terms tools' approval `args.terms` must be a strict `TermsInput`; `isUtcTimestamp` moved from the proof module to the encodings module (same export name).
