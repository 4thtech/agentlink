---
section: Security
---

- Paid actions need your own verification (M1-PAY-CONFIRM-a, S2, D-132, 04 §2.5.3): approving a proof above your limits, or changing those limits, now goes through a confirmation that asks your computer to verify it is you (Touch ID, Windows Hello, a passkey or a PIN) and is bound to the amount and purpose shown. It works once, for 2 minutes, and only on your own page, and the answer must carry your passkey's own signature; your AI can't confirm it for you. A passkey set up before this version uses the backup code for paid actions until you set it up again. The backup code still works, with three tries. Proofs inside your limits stay automatic. The confirmation sheet itself is built (M1-PAY-CONFIRM-b).
