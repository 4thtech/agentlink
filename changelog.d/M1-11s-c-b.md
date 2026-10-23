---
section: Security
---

- Owner setup on the first-run page checks that the held owner key is the one the page showed before it saves anything, and a new test checks that neither the owner key nor the passkey output appears in any log, event, response or error (M1-11s-c-b). Security spec 04 §2.2 now names the two cases where setup keeps what it wrote: an unconfirmed card and a keychain that refuses the clean-up (proposed, owner confirms at merge).
