---
section: Security
---

- Proof checks now verify the signing agent's owner-signed profile and require the message's sender to match it (M1-4d-b, S2, 07 §8, IR-M1-4d-1 M-1); a profile that is not signed by its owner, or that had expired, is refused. Disclosed content is not yet credited to the signing agent: full sender attribution is in development. Not user-facing yet.
