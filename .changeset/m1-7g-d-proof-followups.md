---
'@4thtech-io/core': patch
'@4thtech-io/log': patch
---

Proofs and logging (M1-7g-d): the logger takes an allowlist of fixed codes (`createLogger({ codes })`, `logger.withCodes()`), so a top-level `code` field keeps only listed codes and every other value stays redacted; the proof flow lists its own codes (`PROOF_LOG_CODES`). An approved `confirm` now signs its `ACCEPTED` receipt on the other side's ACCEPT record, once, under the same approval. A contact can hold at most 32 of the 256 `proof` envelopes that wait for their message (`PROOF_AWAITING_PER_CONTACT`); beyond that the envelope is dropped as `proof_unchecked`.
