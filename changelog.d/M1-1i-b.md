---
section: Added
---

- Test vectors (M1-1i-b, S2): two new suites, pending until their code lands. `stream` (M1-1d) covers `ALF1` file encryption with the D-80 chunk AAD `header ‖ isFinal` (04 §4): empty, 1-byte, one-chunk, chunk + 1, multi-chunk, exact-multiple and inline-cap files, and rejection of tampered headers, reordered, dropped, truncated or appended chunks, a flipped final flag and a wrong nonce. `eip712-revocation` (M1-1j) covers EIP-712 hashing of the D-81 `Revocation` struct (05 §4), a `Registration` and a `Revocation` sharing one owner nonce, and the `Revocation` JSON-form rejections.
