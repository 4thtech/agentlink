---
section: Changed
---

- Proof checks can now confirm who sent a message (M1-4d-d, S2, 07 §8, D-102): a proof whose agent profile carries the agent's own signatures over it, and whose message checks out, is shown as fully verified. Without them the proof still shows the record but not the sender (`card_pop_missing`); a forged signature, or one taken from another profile, makes the proof fail (`card_pop_invalid`). Adding these signatures when agents set up, pair and update their profiles follows in the next change.
- Spec wording (04 §2.9, §3.4.1, §3.6): an invalid `cardAgentSig` or `cardPop` drops the whole `handshake`, `handshake-ack` or `card-update`; a `card-update` needs neither for acceptance but the core still sends both; A checks a `handshake`'s `cardPop` when present.
