---
'@agentlink/crypto': minor
---

Add `senderCode(from)` and the frozen tag `TAGS.senderCode` (`agentlink/sender-code/v1`): the 04 §2.9 sender code of an unknown sender (D-72), the tagged hash over the 32 raw bytes of its envelope `from` key, shown with `formatFingerprint(…, 'short')` as in "unknown sender · 2B9E·04D1". Any other length is refused. Display only: it tells senders apart and authenticates nothing.
