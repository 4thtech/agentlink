---
section: Changed
---

- Received receipts are on by default (SEC-RECEIPTS-DEFAULT, S2, D-156): when your AI app receives a message from one of your contacts, it tells them, so their app shows "Received by <name>'s app". Each receipt waits a random 5 to 90 seconds and carries its time rounded to the minute. Turn it off in Settings › Rules with "Tell contacts when your AI receives a message"; a one-time notice on Home (and once in an AI app's status) says so to people who upgraded. Receipts from older apps show as "Received (older app)", and a message sent with proof shows as delivered only with the new receipt. On request (off by default), a proof file includes the contact's receipt, labelled "automatic device receipt" and kept apart from public receipts; it then also names the recipient, and a checker accepts the receipt only for that recipient. Proof packs made with 0.5.10 need 0.5.10 or later to verify; 0.5.10 verifies packs from both versions.
