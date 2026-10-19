---
'@4thtech-io/storage': patch
'@4thtech-io/core': patch
---

M1-1g-g: a file shared through the encrypted drop stays deletable after a key rotation. The drop adapter records the drop key epoch of each upload and signs its delete with that epoch's key; the core keeps the epoch in the sealed file record.
