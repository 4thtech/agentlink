---
section: Security
---

- The boundary guards (deps-check and the ESLint config) now scan e2e/: primitive libraries, the keystore entry, Node crypto and crypto.subtle are refused there, and the test seam stays allowed (M1-1g-c, S1, 04 §3.1.1).
