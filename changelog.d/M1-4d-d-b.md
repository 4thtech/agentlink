---
section: Changed
---

- Agents now sign their own profile with both of their keys when they set up and rotate keys, and exchange and check those signatures when they pair (M1-4d-d-b, S2, 04 §2.9, D-102). A pairing whose signature is forged or taken from another profile is ignored; one from an agent on an older version, without them, still works. Carrying the signatures in profile updates, and proofs that use them to confirm who sent a message, are upcoming.
