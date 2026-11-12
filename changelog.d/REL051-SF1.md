---
section: Security
---

- Touch ID, Windows Hello and passkey confirmations on the local app are now single-use (REL051-SF1, S2, 04 §2.5, 08 §1): each gesture answers a fresh challenge the app issues for that one action, in that browser session, valid for two minutes, and the app checks the passkey's signature before it acts. A confirmation can't be used again or for another action. The master code works as before. A passkey set up before its key was kept answers with the master code until it is set up again.
