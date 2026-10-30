---
section: Added
---

- Short invite links (W4-SHORT-INVITE, S2, D-139, 04 §3.6.2): a new invite link is under 80 characters. The invite is encrypted on your computer and kept on the encrypted drop until it is used, cancelled or expires (at most 7 days); 4thTech only ever holds ciphertext. If the drop can't be reached within 10 seconds, you get the long link automatically, and you can always choose the long link under Advanced or with `agentlink invite --long`. Older long links keep working.
- Open invites in the app (W4-INVITES-LIST, S2, 08 §1): Contacts lists the invites you created, with who they are for and when they expire, and a Cancel button. A lost link can't be shown again: cancel it and create a new one.
