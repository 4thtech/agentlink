---
'@4thtech-io/crypto': minor
'@4thtech-io/core': patch
'@4thtech-io/transport-nostr': patch
'@4thtech-io/chain': patch
'@4thtech-io/agentlink': patch
---

Owner approvals, policies and revocations, envelopes, agent cards and proof packs are now checked from the exact text received: text that repeats a field name or spells one with an escape sequence is refused as malformed before the signature is checked (M1-1h-b, D-128). New in `@4thtech-io/crypto`: `parseReceivedJson`, `parseEnvelopeText` and the `plainMemberNames` option of `parseJson`.
