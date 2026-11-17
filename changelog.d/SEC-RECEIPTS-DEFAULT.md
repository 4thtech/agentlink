---
section: Changed
---

- Received receipts are on by default (SEC-RECEIPTS-DEFAULT, S2, D-156): when your AI app receives a message from one of your contacts, it tells them, so their app shows "Received by <name>'s app". Each receipt waits a random 5 to 90 seconds and carries its time rounded to the minute. Turn it off in Settings › Rules with "Tell contacts when your AI receives a message"; a one-time notice on Home says so. Receipts from older apps show as "Received (older app)", and a message sent with proof shows as delivered only with the new receipt. Proof files include the contact's receipt, labelled "automatic device receipt" and kept apart from public receipts; the owner can leave it out. Proof packs made with 0.5.10 need 0.5.10 or later to verify; 0.5.10 verifies packs from both versions.
