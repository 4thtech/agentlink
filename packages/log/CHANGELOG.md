# @4thtech-io/log

## 0.4.3

No changes in this release.

## 0.4.2

No changes in this release.

## 0.4.1

No changes in this release.

## 0.4.0

No changes in this release.

## 0.3.0

No changes in this release.

## 0.2.0

### Patch Changes

- 9c56860: M0-8c: the redacting logger no longer over-redacts after an apostrophe in a bracketed value, reduces a JSON-escaped protocol-relative URL to its host, and redacts `upload` URL fields whole.
- 4be1e27: Proofs and logging (M1-7g-d): the logger takes an allowlist of fixed codes (`createLogger({ codes })`, `logger.withCodes()`), so a top-level `code` field keeps only listed codes and every other value stays redacted; the proof flow lists its own codes (`PROOF_LOG_CODES`). An approved `confirm` now signs its `ACCEPTED` receipt on the other side's ACCEPT record, once, under the same approval. A contact can hold at most 32 of the 256 `proof` envelopes that wait for their message (`PROOF_AWAITING_PER_CONTACT`); beyond that the envelope is dropped as `proof_unchecked`.

## 0.1.2

No changes in this release.

## 0.1.1

No changes in this release.

## 0.1.0

### Patch Changes

- 1377cb5: Harden the log redaction: values with escaped quotes, nested JSON or objects and arrays are redacted in full, with no length cap that would let the tail of a long secret through; backslash, JSON-escaped and protocol-relative URLs are reduced to their origin; the cost of the pair scanner is bounded.
