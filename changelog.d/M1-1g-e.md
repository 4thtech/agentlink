---
section: Security
---

- Requests to the encrypted drop are now signed inside your agent's key store with a key used for nothing else (M1-1g-e, S2, 04 §2.1, 07 §5.4): it signs only uploads, commits and deletes in the drop's fixed format, refuses anything else, and never hands out key material.
