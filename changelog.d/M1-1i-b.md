### Added

- Test vectors (M1-1i-b, S2): two new suites, pending until their code lands. `stream` (M1-1d) covers `ALF1` file encryption with the D-80 chunk AAD `header ‖ isFinal` (04 §4): empty, 1-byte, one-chunk, chunk + 1, multi-chunk, exact-multiple and inline-cap files, and rejection of tampered headers, reordered, dropped, truncated or appended chunks, a flipped final flag and a wrong nonce. `eip712-revocation` (M1-1j) covers EIP-712 hashing of the D-81 `Revocation` struct (05 §4), a `Registration` and a `Revocation` sharing one owner nonce, and the `Revocation` JSON-form rejections.

### Changed

- Spec (M1-1i-b, proposed, owner confirms at merge): 04 §4 fixes the ALF1 version byte (`0x01`), the chunking at chunk boundaries (a full final chunk; an empty one only for an empty file) and the chunk size (senders 1 MiB; recipients accept 1 B to 16 MiB); 05 §4 and 04 §2.4.1 define the `Revocation` JSON form.
