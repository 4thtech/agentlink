---
'@agentlink/crypto': patch
---

ALF1 STREAM file encryption (M1-1d, D-80): push-based sealer and opener, Web Streams encrypt and decrypt transforms and whole-buffer helpers for the 04 §4 object (AAD = header ‖ isFinal), with incremental SHA-256 of ciphertext and plaintext, chunk-size and chunk-count bounds, and optional expected-hash checks when opening.
