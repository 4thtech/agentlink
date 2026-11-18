---
section: Security
---

- Refused file sends leave nothing behind (SEC-REFUSED-UPLOAD-CLEANUP, S2; 04 §3.4, 07 §5.6): when a send with files is refused after the files were stored, the stored copies are deleted, retried a few times, and any still left are removed on a later pass. The send stays refused either way, and the usual refusals are now checked before anything is stored.
