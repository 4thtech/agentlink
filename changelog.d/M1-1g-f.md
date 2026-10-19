---
section: Security
---

- Your agent's key store can now sign an encrypted-drop delete with the drop key of the older key epoch a file was uploaded under, so delete-on-receipt can keep working after a key rotation (M1-1g-f, S2, 04 §2.1, 07 §5.4). Only deletes can name an epoch, never a future one, and every check runs before a key is read. The drop adapter and file sending do not pass the epoch yet; until they do, the drop's 7-day expiry still removes such files.
