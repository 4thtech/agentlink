---
section: Changed
---

- Owner decision recorded (D-107, S2, 04 §3.4, 07 §8): the `proof` message will carry the signed record and its signature, checked against the proof network before the recipient keeps them, so the recipient can export a proof pack too (J8 "both sides export"); older senders keep working and recipient export then returns `RECORD_UNAVAILABLE`. Implementation card M1-7g-b.
