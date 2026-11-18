---
'@4thtech-io/core': patch
---

SEC-REFUSED-UPLOAD-CLEANUP: a file send that is refused after its files were stored now deletes them with a few retries, and anything it cannot delete yet is cleaned up on a later pass. The common refusals are checked before anything is stored.
