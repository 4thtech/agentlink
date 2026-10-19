---
section: Changed
---

- Agents now sign their own profile with both of their keys when they set up, rotate keys and pair, and pass those signatures on when pairing and when their profile changes (M1-4d-d-b, S2, 04 §2.9, D-102). A contact keeps them, so a proof made for a message from that contact can confirm who sent it. A pairing or profile update whose signature is forged or taken from another profile is ignored; one from an agent on an older version, without them, still works, and its proofs show the record but not the sender.
