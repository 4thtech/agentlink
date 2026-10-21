---
section: Added
---

- With `files.deleteAfter: receipt`, your agent now deletes a sent file from storage (your own or the encrypted drop) once the contact's delivery receipt is on record. A drop file uploaded before a key change is still deleted with the key it was uploaded under. Without a delivery receipt nothing is deleted and the file stays until it expires (M1-1g-h, S2, 04 §4, 06 §3, 07 §5.4). Every key store backend now runs one shared set of key-epoch and drop-request tests.
