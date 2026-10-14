# G-46 decision note: one plaintext for every recipient

| | |
|---|---|
| **Status** | **Decided: D-66** (Tali, 14 Oct 2026): A + D, as recommended by the independent review IR-G-46-1 (sound with changes). The normative text is in 04 §3.1, §3.1.1 and §3.3 and in 07 §8; where it differs from this note, the spec wins. In particular, the spec fixes `skE_j = ikm_j` as the raw X25519 secret, not `DeriveKeyPair` (IR-G-46-1 F-2). The new gap for T6 is G-48. This note is kept as the rationale. |
| **Gap** | G-46 (H), `docs/process/backlog.md` §8 |
| **Requirement** | D-61 (5), stated in 04 §3.3: every recipient entry, every owner (I-9) and a proof-pack verifier obtain the same plaintext for a given `envelopeHash`, or fail to decrypt |
| **Timing** | D-62: fixed before M1-7b becomes `ready` and before the `aead-envelope` and `envelope-sig` vectors freeze |
| **Security class** | S2 (envelope cryptography, I-2, I-8, I-9) |
| **Date** | 14 Oct 2026 |
| **Where this file lives** | The repository had no convention for proposals (no `docs/foundation/proposals/`, no proposal files anywhere under `docs/`). This note therefore sits under `docs/process/proposals/` and is the first file there. The specs stay the source of truth (`docs/README.md`). |

## 0. Summary

- **Today, a malicious sender can make two parties that open one signed envelope read different payloads.** It can also make some entries fail to open while others open. The envelope signature does not stop either, because the sender is the signer.
- **Recommendation:** derive the payload key and a 32-byte key commitment from the CEK with HKDF-SHA256, put the commitment in the signed `aead` member, and check it before decrypting (Option A). Also derive each recipient's HPKE ephemeral key from the CEK, so that anyone who holds the CEK can recompute every wrap and check that it carries the same CEK (Option D). A meets D-61 on its own; D also closes "owner exclusion", the I-9 hole that D-61 leaves open.
- **Cost:** 51 bytes per envelope (the worst case is 24 563 of 24 576 bytes, so the `ct` cap stays 17 152). Two HKDF calls per envelope, plus up to 7 HPKE seals when opening. Only allowlisted libraries are used, and no new primitive is introduced.

---

## 1. The construction today

What is specified (04 §3.1, §3.1.1, §3.3) and merged (#38: `packages/crypto/src/aead.ts`, `hpke.ts`, `envelope.ts`):

- `CEK`: 32 random bytes per envelope (`generateCek`).
- Recipient entry `j`: `(enc_j, wk_j) = HPKE.SealBase(pk_j, info = "agentlink/v1/cek" ‖ id, aad = "", pt = CEK_j)` with a fresh random ephemeral key (`wrapCek`). Nothing forces `CEK_j` to be the same for every `j`. The sender calls `wrapCek` once per recipient and could pass a different key each time.
- Payload: `aead.ct = AES-256-GCM(key = CEK, iv, AAD = sha256(JCS({v, id, thread, from, createdAt, recipients})), payload)`. The CEK is used directly as the GCM key.
- `envelopeHash = sha256(JCS(envelope without sig))` covers the header, every `(kid, enc, wk)` and `aead` (`alg`, `iv`, `ct`). `sig` is BIP-340 by `from` over `taggedHash("agentlink/envelope/v1", envelopeHash)`.
- Opening (04 §3.1.1 step 5): exactly one `unwrapCek` of the opener's own entry, then `decryptPayload(envelope, cek)`. Step 8 checks that the own owner's `kid` is present, and the spec says explicitly that this "shows that an entry is present, not that it opens".
- Proof pack (07 §8): optional `envelope`, plus `disclosure.contentKey` (the CEK). The verifier "optionally decrypt[s] with disclosed key" (07 §6.2).

AES-GCM is not key-committing: one `(iv, ct ‖ tag)` can be built so that it authenticates under two chosen keys (Grubbs–Lu–Ristenpart 2017; Dodis–Grubbs–Ristenpart–Woodage 2018; Albertini et al. 2022). Nothing in the construction above compensates for that.

## 2. Threat model

### 2.1 Parties and goal

- **Parties:** the sender `S` (signs the envelope), the recipient agent `B`, B's owner `O_B`, S's owner `O_S`, S's own entry, a P2 arbitrator, and a third-party proof-pack verifier `V` with a disclosed key.
- **Goal (D-61):** for one `envelopeHash`, every party that decrypts gets the same plaintext.
- **Adjacent goal (I-9):** every owner can decrypt every envelope its agents send or receive. D-61 explicitly allows "or fail to decrypt", so selective failure is not a D-61 violation, but it is an I-9 problem (T3).
- **Adversaries:** a malicious sender, a malicious recipient, a sender and a recipient who collude (for example a sender who also exports the proof pack), and relays or the network.

### 2.2 Attacks

| # | Attacker | How | Effect | Blocked by `sig` over `envelopeHash`? |
|---|---|---|---|---|
| T1 | Sender | **Two-key ciphertext ("invisible salamander").** Wrap `K1` to B and `K2` to `O_B`, with one `ct` that GCM accepts under both keys (§2.3) | B acts on `P1`; `O_B` reviews `P2`. Both pass the signature, `kid`, AEAD and step 8 checks | **No.** S is the signer, and the hash faithfully covers the crafted `wk`s and `ct` |
| T2 | Sender | **Different CEKs, honest GCM.** Wrap `K1` to some entries and `K2` (or junk) to others; encrypt under `K1` | Entries with `K1` read `P`; the rest get `open_failed` | **No** |
| T3 | Sender | **Owner exclusion**, the I-9 case of T2: B's entry opens, `O_B`'s entry is junk | B reads and acts; B's owner cannot read what its agent received. Step 8 passes because the entry is present | **No** |
| T4a | Pack exporter (any recipient) | Discloses a key `K' ≠ CEK` for an honestly built envelope | To succeed, `K'` must pass the GCM tag on a `ct` the exporter did not choose: about 2^-128 per guess. In practice it only causes a failure | Not needed: infeasible today |
| T4b | Sender who exports the pack, or a recipient colluding with the sender | Builds a T1 envelope, gets it notarized and `ACCEPTED`, and later discloses whichever key suits them | `V` decrypts terms `Y`, while the counterparty had read and accepted terms `X`. Breaks proof of agreement (04 §3.4, D-32) | **No.** The receipt and the record bind `envelopeHash`, which T1 leaves ambiguous |
| T5 | Relay, network, or a recipient re-encrypting | Swaps a `wk`, re-wraps another recipient's entry, or re-encrypts the payload under a fresh key | Any change to `recipients` or `aead` changes `envelopeHash`; the copy then fails `sig` and no longer matches the record | **Yes, fully.** A recipient can make a *new* envelope (new hash), never a new plaintext under the signed one |
| T6 | Sender | **Per-recipient equivocation at the transport:** gift-wraps envelope `E1` to B and a different `E2` (same `id`, different hash) to `O_B` | Each party sees one consistent envelope; the step 9 conflict check fires only for a party that holds both | Not a G-46 case (the hashes differ). Out of scope here; see owner decision 6 |

**Exactly what the signature blocks:** any change, by anyone other than `from`, to the header, the wraps, `iv` or `ct` (T5), and replay of an altered copy under the notarized hash. It also makes T1, T2 and T4b attributable after the fact: a party that obtains two keys that both open the signed `ct` holds proof that `from` equivocated. **It blocks nothing the signer itself does** (T1, T2, T3, T4b), and G-46 is about exactly those cases.

### 2.3 T1, concretely (AES-GCM)

1. S picks two keys `K1`, `K2`, an `iv`, and the plaintext `P1` it wants B to read.
2. S computes the two CTR keystreams `KS1`, `KS2` and the two GHASH keys `H1 = AES_K1(0^128)` and `H2 = AES_K2(0^128)`.
3. S sets `ct = P1 ⊕ KS1`, except for one free 16-byte block. The condition that both keys give the same tag, `GHASH_H1(A, ct) ⊕ AES_K1(J0) = GHASH_H2(A, ct) ⊕ AES_K2(J0)`, is linear in that block over GF(2^128), so S solves for it. That gives one `ct ‖ tag` valid under both keys (Dodis et al. 2018; Albertini et al. 2022).
4. S wraps `K1` in B's entry and `K2` in `O_B`'s entry (and any mix for the other entries), then signs.
5. B decrypts `P1`. `O_B` decrypts `P2 = ct ⊕ KS2`, which equals `P1 ⊕ KS1 ⊕ KS2` outside the solved block. Both decryptions authenticate.

### 2.4 How practical is T1 against today's payload?

`P1 ⊕ P2` is fixed by the keys, so S cannot choose both plaintexts byte for byte. It needs a format in which each byte is meaningful in one plaintext and tolerated in the other. Published attacks use permissive formats (polyglot images, archives). Our payload is strict JSON (04 §3.4, M1-2a) with fixed structural bytes, so making **both** sides meaningful costs S a large offline search over `(K1, K2, iv)`. Our rough estimate is well beyond published demonstrations, but:

- we have no proof of that bound, and it depends on the payload grammar, which will change (inline files, new types, `terms`);
- the cheap variant needs no search at all: if `P2` is junk, `O_B`'s copy fails its schema while B acts on `P1`, which is T3 by another route;
- D-61 is stated without any format assumption.

**We therefore treat T1 as in scope** and do not rely on the payload grammar. T2 and T3 need no cryptanalysis at all; any modified client can do them today.

### 2.5 Corrections to the brief and the gap text

1. "A sender could wrap different CEKs to different recipients": on its own (T2), that produces **failure**, not a different plaintext. Different plaintexts need T1's non-committing ciphertext as well. The selective failure that T2 does produce matters for I-9 (T3).
2. "Either option changes the envelope header" (G-46 entry): Option A adds a field to `aead`, which is covered by `envelopeHash` and the signature, but not to the six-field AAD header. Option D changes no wire bytes at all, only how the wraps are computed.
3. Brief option (c): XChaCha20-Poly1305 is **not** key-committing either (Len–Grubbs–Ristenpart 2021 build multi-key collisions for ChaCha20-Poly1305 as well as AES-GCM). Switching ciphers alone fixes nothing. `@noble/ciphers` **is** allowlisted (04 §8.1 `@noble/*`; `tools/deps-check/policy.mjs`) and is already a runtime dependency of `packages/crypto` (2.4.0, used by NIP-44).
4. Brief option (b): CTX cannot be built from the APIs we have without composing GCM's internals ourselves (§3, Option B), which I-8 and CR-1 forbid.
5. Brief option (d): one CEK with a commitment that every recipient checks (that is Option A) guarantees one plaintext among those who **succeed**. It does not show that the **other** entries carry that CEK. That needs Option D.

---

## 3. Candidate constructions

Notation: `HKDF(ikm, salt, info, L)` is HKDF-SHA256 (RFC 5869), as `hkdfSha256` in `packages/crypto/src/hkdf.ts`. `id` is the envelope id (16 raw bytes). `‖` is concatenation. Labels follow the existing `agentlink/v1/...` scheme.

### Option A: derived payload key and a CEK commitment in the signed `aead` (recommended)

**Construction** (UtC pattern; the same shape as the AWS Encryption SDK's committing suites):

```
encKey = HKDF(ikm = CEK, salt = "", info = utf8("agentlink/v1/payload-key")    ‖ id, L = 32)
kc     = HKDF(ikm = CEK, salt = "", info = utf8("agentlink/v1/payload-commit") ‖ id, L = 32)
aead   = { alg: "A256GCM-KC", iv: 12 random bytes, kc, ct: AES-256-GCM(encKey, iv, AAD, payload) }
```

Opening: `unwrapCek` gives the CEK. `kc'` is derived and compared with `aead.kc` in constant time; a mismatch is `open_failed`, the same error as a failed GCM tag. Only then is `encKey` derived and GCM opened. The CEK and `encKey` are wiped afterwards. The check lives inside `decryptPayload`, so every caller gets it: core, the owner surfaces and `verifyProofPack`.

**Variant A2:** `kc = taggedHash("agentlink/cek-commit/v1", id ‖ CEK)` and GCM directly under the CEK. It is equally binding, but it publishes a hash of the very key that GCM uses. A keeps the published value and the cipher key separate, derived from a parent key, at the same cost. Prefer A.

**Security argument.**
- **Key commitment (CMT-1).** Two different CEKs with the same `kc` would be a collision of HKDF-SHA256 over a fixed-length 32-byte input: generically about 2^128 work. The CEK is the HMAC *message* in Extract, and the PRK is a fixed 32-byte HMAC key in Expand, so HMAC's key-padding equivalence does not arise. The parser fixes `kc` at 32 bytes. A 16-byte `kc` would give only about 2^64, because the attacker picks both keys.
- **Context commitment relative to `envelopeHash`.** `envelopeHash` determines `kc`, `iv`, `ct` and the header from which the AAD is computed (SHA-256 collision resistance over JCS). `kc` determines the CEK, hence `encKey`. AES-GCM decryption is a deterministic function of `(encKey, iv, AAD, ct)`. So `envelopeHash` determines the plaintext, which gives CMT-4 for our setting (Bellare–Hoang 2022) without changing GCM.
- **One-plaintext guarantee.** Any two parties that pass the `kc` check on the same signed envelope hold the same CEK, and so get the same plaintext. That covers B, every owner, and `V` with a disclosed CEK. Everyone else fails. This meets D-61 and blocks T1 and T4b.
- **Confidentiality.** HKDF with a uniform 256-bit CEK yields `encKey` and `kc` as independent pseudorandom values (Krawczyk 2010), so `kc` reveals nothing about `encKey`. AES-GCM keeps its usual guarantees, and the key is single-use. The random `iv` is kept as defence in depth against a CEK-reuse bug.
- **Not covered:** T2 and T3 (an entry that carries another key still just fails), and T6.

**Cost.**
- **Bytes:** `,"kc":"<43 chars>"` adds 51 bytes; the alg rename adds 3 more. The worst-case envelope (8 entries, `ct` of 17 152 bytes, `createdAt` = 2^53 − 1) grows from 24 509 to **24 563 bytes as JCS**, which is at most 24 576. The `ct` cap and the 17 136-byte payload limit are unchanged, and 13 bytes of headroom remain.
- **CPU:** two HKDF-SHA256 calls (a few HMAC compressions) per encrypt and per open. That is negligible next to X25519 and GCM over up to 17 KB.

**Impact.**
- **HPKE wrap:** none. The wrap still carries the CEK, and `info` is unchanged.
- **Files (ALF1 STREAM, M1-1d, M1b):** none. `fileKey`, `ciphertextSha256` and `plaintextSha256` are inside the payload, which is now unique per `envelopeHash`. A recipient checks `ciphertextSha256` before decrypting and `plaintextSha256` after (04 §4), so every party gets the same file bytes or fails, even though ALF1's GCM chunks are not key-committing. G-26 (header in the AAD) is independent of this.
- **Proof packs (07 §8):** `contentKey` stays the CEK, never `encKey`, because only the CEK can be checked against `kc`. `envelope` becomes mandatory whenever `disclosure` is present. `verifyProofPack` checks the hash, then the signature, then `kc`, then decrypts. T4b is closed.
- **Owner copies (I-9):** the owner checks `kc` like any recipient, so the owner reads the same plaintext as the agent or fails.
- **Merged code:** `envelope.ts` (exact `aead` keys `alg`, `iv`, `kc`, `ct`; `AEAD_ALG`; a `kc` length constant); `aead.ts` (derive and check); `packages/types/src/envelope.ts` (`aeadSchema` and fixtures); test fixtures in `packages/transport-nostr/src/gift-wrap.test.ts`, `aead.test.ts` and `envelope.test.ts`. No interface of `KeyStore` or `EnvelopeKeys` changes.
- **Vectors:** regenerate `aead-envelope` (every envelope, the AAD, hash, sign and decrypt cases, and the size cases: 24 509 becomes 24 563) and `safety-code-recompute` (its signed handshakes embed `aead`), with `generate_aead_envelope.py`, `generate_safety_code.py` and `generate_safety_code_recompute.py`. Add reject cases: missing `kc`, wrong `kc` (one flipped bit), 31- or 33-byte `kc`, old `alg`, and a T1 envelope that opens under GCM with both keys but fails `kc` for one of them. `hpke` is unchanged. `envelope-sig` is not committed yet, so it is written on the new form.

**Migration:** small. Nothing is released (`packages/*` are `private`, version 0.0.0), and no envelope exists outside tests, so `v` stays 1 with no compatibility path. Cards: M1-1c follow-up (S2), M1-2a follow-up (types), M1-1h (vectors), M1-5a (test fixtures), M1-7b (tests only), M1-4d and M1-7g (pack rules), DOCS-M1a (docs-site), plus the spec PR.

**References:** RFC 5869 (HKDF); Krawczyk, "Cryptographic Extraction and Key Derivation: The HKDF Scheme" (CRYPTO 2010); Bellare and Hoang, "Efficient Schemes for Committing Authenticated Encryption" (EUROCRYPT 2022: CMT-1/CMT-4, UtC); the AWS Encryption SDK message format version 2 (committing algorithm suites, key commitment in the header); the age v1 format (C2SP), whose header MAC under a file-key-derived key plays the same binding role.

### Option B: generic transforms over AES-GCM (CTX, HtE, padding fix)

- **CTX** (Chan and Rogaway 2022) replaces the GCM tag `T` with `H(K, N, A, T)`. It is CMT-4 with no extra ciphertext beyond the hash length (+16 bytes with SHA-256; worst case ≈ 24 531 bytes). **But** the decryptor must recompute the raw GCM tag without verifying it. WebCrypto and `@noble/ciphers`' `gcm` only expose verify-and-decrypt. We would have to rebuild GCM from AES-CTR and GHASH ourselves, which is a custom composition of primitives that I-8 and CR-1 forbid. **Not implementable under our rules.**
- **HtE** (Bellare and Hoang 2022) derives `K' = H(K, N, A)`. It upgrades a CMT-1 scheme to CMT-4 but does not make GCM CMT-1: two chosen `K` still give two chosen `K'`, and T1 applies to them. Our signature over `envelopeHash` already gives the context part. Not useful on its own; combined with a commitment, it is Option A.
- **Padding fix** (Albertini et al. 2022): prepend 16 zero bytes and check them on decryption. For GCM this commits only up to about 2^64 work (a birthday search for two keys with the same first keystream block), and it is not context-committing. Below our 128-bit bar.
- **Verdict:** rejected. CTX would be the elegant choice with a suitable API, but it does not fit I-8 here.
- **References:** Chan and Rogaway, "On Committing Authenticated-Encryption" (ESORICS 2022); Bellare and Hoang (EUROCRYPT 2022); Albertini, Duong, Gueron, Kölbl, Luykx and Schmieg, "How to Abuse and Fix Authenticated Encryption Without Key Commitment" (USENIX Security 2022); Menda, Len, Grubbs and Ristenpart, "Context Discovery and Commitment Attacks" (EUROCRYPT 2023).

### Option C: XChaCha20-Poly1305 (`@noble/ciphers`) plus a commitment

- **Allowlist:** yes (`@noble/*`; already a runtime dependency).
- **Security:** Poly1305 is not key-committing (Len et al. 2021), so the commitment still has to come from Option A. The 24-byte nonce buys nothing here, because the payload key is single-use. AES-GCM-SIV (RFC 8452), also in `@noble/ciphers`, is not key-committing either. To our knowledge `@noble/ciphers` ships no key-committing AEAD; the builder confirms this against the pinned version.
- **Cost:** +16 bytes for the nonce and +51 for `kc`, so the worst case is 24 579 bytes or more (more with a longer `alg`), above the 24 576-byte limit unless the `ct` cap drops (corrected after IR-G-46-1 F-7). The cipher runs in pure JS instead of hardware AES through WebCrypto; that is fine for 17 KB, but it adds a second payload cipher next to HPKE's and ALF1's AES-GCM.
- **Impact:** the same as A, plus a second AEAD in the vectors and the audit scope, and divergence from the HPKE suite and ALF1.
- **Verdict:** no gain over A. Rejected.
- **References:** RFC 8439 (ChaCha20-Poly1305); the XChaCha IRTF draft (draft-irtf-cfrg-xchacha); Len, Grubbs and Ristenpart, "Partitioning Oracle Attacks" (USENIX Security 2021).

### Option D: one CEK bound to every entry (A plus re-derivable wraps; recommended with A)

**Construction:** Option A, plus each wrap's HPKE ephemeral key is derived from the CEK and the recipient's key:

```
ikm_j            = HKDF(ikm = CEK, salt = "", info = utf8("agentlink/v1/cek-eph") ‖ id ‖ pk_j, L = 32)
(skE_j, pkE_j)   = DeriveKeyPair(ikm_j)                    // RFC 9180 §7.1.3, DHKEM(X25519, HKDF-SHA256)
(enc_j, wk_j)    = SealBase(pk_j, info = "agentlink/v1/cek" ‖ id, aad = "", pt = CEK) using skE_j
```

**Check:** after the `kc` check, an opener recomputes `(enc_j, wk_j)` for every entry whose `pk_j` it knows and compares the bytes. Any mismatch refuses the envelope (`open_failed`); it is stored as refused and the contact is flagged.
- **Minimum, always possible:** an agent checks its own owner's entry. The `ownerEnc` comes from its own card, so step 8 becomes "present **and** carries the committed CEK". An owner surface checks its agent's entry.
- **Otherwise:** every entry whose key the opener knows from cards (the §3.2 set for a known contact). A key that is not yet known (a request from an unknown sender) is checked once its card arrives.

**Security argument.**
- **Consistency (T2, T3):** HPKE is a deterministic function of `(pk_j, skE_j, info, aad, CEK)`. Byte equality with the recomputed `(enc_j, wk_j)` means that the holder of `sk_j` opens exactly this CEK (HPKE correctness; we already refuse small-order keys). No cryptographic assumption is needed for this part. The sender has no free choice per entry, so a checked envelope cannot exclude the checker's owner.
- **Confidentiality:** the ephemeral randomness is a function of the encrypted message. This is the "encrypt-with-hash" and Fujisaki–Okamoto derandomisation pattern. It is secure when HKDF is modelled as a random oracle and the message has high min-entropy (the CEK is uniform, 256 bits). An outsider who cannot guess the CEK sees `pkE_j` values indistinguishable from fresh ones. `id` and `pk_j` in `info` keep every derived ephemeral key distinct.
- **Accepted consequence:** every co-recipient can compute `skE_j`, and hence the HPKE context of every other entry. That gives them nothing they lack, because they already hold the CEK. **Rule:** these HPKE contexts are used for the single CEK seal only, never for the exporter or a second message.
- **Proof packs:** with the disclosed CEK and the counterparty's card (`agentEnc`), `V` can also confirm that the counterparty's entry carried this CEK. This is optional; A alone already gives V one plaintext.

**Cost.**
- **Bytes:** none beyond A.
- **CPU:** the sender does the same work as today (key derivation replaces randomness). An opener does up to 7 extra HPKE seals: per entry, two X25519 operations, the key schedule and GCM over 32 bytes. On WebCrypto that is a few milliseconds per envelope; M1-1c measures it.

**Impact.**
- **HPKE wrap:** `wrapCek` becomes deterministic, with the same signature. The existing explicit-ephemeral path (`wrapCekWithEphemeralKey`, `ekm` in `hpke.ts`) already passes a caller-chosen ephemeral key to `@hpke/core`. The builder confirms `DeriveKeyPair` through `@hpke/core`'s KEM; otherwise the X25519 secret is taken directly as `ikm_j` (clamping makes any 32 bytes valid). This is a choice for the spec PR, and the vectors fix it.
- **New helper:** `checkWrap(pk, id, cek, entry)` in the main entry (public key and CEK only, no secret key).
- **`unwrapCek`, `KeyStore` and `EnvelopeKeys`:** unchanged.
- **Vectors:** the `hpke` suite gains derived-ephemeral cases and keeps the RFC 9180 cases. The AgentLink envelopes in `aead-envelope` and `safety-code-recompute` become reproducible from the CEK alone, with no ephemeral-key seam needed.
- **Files:** none.
- **Owner copies:** the I-9 check becomes real for the receiving agent's owner and the sending agent's owner.
- **Core:** M1-7b step 5 and step 8 gain the recomputation, and tests cover T2 and T3 refusals.

**Migration:** small to medium on top of A. Cards: the M1-1c follow-up (hpke.ts and the helper), M1-1h (`hpke` cases), M1-7b (steps 5 and 8 plus tests), and the owner surfaces when they land (M2 console, read path).

**References:** RFC 9180 §7.1.3 (DeriveKeyPair); Fujisaki and Okamoto, "Secure Integration of Asymmetric and Symmetric Encryption Schemes" (CRYPTO 1999); Hofheinz, Hövelmanns and Kiltz, "A Modular Analysis of the Fujisaki-Okamoto Transformation" (TCC 2017); Bellare, Boldyreva and O'Neill, "Deterministic and Efficiently Searchable Encryption" (CRYPTO 2007). For context, multi-recipient JWE (RFC 7516) has the same per-recipient freedom and a non-committing content cipher.

### 3.1 Comparison

| | A (commit) | A2 (hash commit) | B (CTX / HtE / padding) | C (XChaCha + A) | D (A + derived wraps) |
|---|---|---|---|---|---|
| Meets D-61 (T1, T4b) | Yes | Yes | CTX yes; HtE no; padding about 2^64 | Yes, through A | Yes |
| Stops T2/T3 (owner exclusion) | No | No | No | No | **Yes** |
| Worst-case envelope (limit 24 576) | 24 563 | 24 560–24 563 | ≈ 24 531 | ≥ 24 579 (over) | 24 563 |
| Extra CPU | 2 HKDF | 1 SHA-256 | — | 2 HKDF, pure-JS cipher | + ≤ 7 HPKE seals on open |
| Allowlisted, no custom composition | Yes | Yes | **No** (CTX) | Yes | Yes |
| Spec and vector churn | Low | Low | — | Medium | Low to medium |
| Verdict | **Adopt** | Fallback | Reject | Reject | **Adopt** |

---

## 4. Recommendation

1. **Adopt A** as the G-46 construction: a payload key and a 32-byte commitment `aead.kc`, both HKDF-derived from the CEK; `kc` is checked inside `decryptPayload` before GCM; `alg` becomes `A256GCM-KC`.
2. **Adopt D now:** derive each wrap's ephemeral key from the CEK, so that every opener can recompute and check the entries it knows, at least its own owner's. This is the only cheap moment, because later it needs a new envelope version.
3. **Proof packs:** a disclosed key always comes with the envelope; the verifier checks hash, then signature, then `kc`, then decrypts.

**Rationale.** A is the smallest standard fix that meets D-61 for every party, including `V`, using only HKDF-SHA256 and the AES-GCM we already have. It fits the size budget without moving the `ct` cap and touches no KeyStore interface. D costs no bytes and closes the I-9 hole that the spec currently documents ("present, not that it opens") with an argument that rests on HPKE correctness. Both change merged code and vectors only in places that have to be regenerated before the freeze anyway. B does not fit I-8, and C adds a cipher without adding commitment.

## 5. Spec changes the recommendation implies

To be made in one S2 spec PR after the owner decides. Nothing below is applied by this note.

**04-security-and-crypto.md**
- **§2.4.1**, base64url row: add `aead.kc`.
- **§3.1**, structure: `"aead": { "alg": "A256GCM-KC", "iv": "<12 bytes>", "kc": "<32-byte key commitment>", "ct": "<ciphertext || 16-byte tag>" }`. Add a bullet with the `encKey` and `kc` derivations (Option A), and state that GCM runs under `encKey`, never under the CEK.
- **§3.1.1, What is signed:**
  - item 1 lists `aead` (`alg`, `iv`, `kc`, `ct`);
  - replace "That alone does not make every recipient read the same plaintext; the requirement is in §3.3 (G-46)" with: the hash covers `kc`, and every opener checks it (§3.3), so everyone who decrypts gets the same plaintext.
- **§3.1.1, Recipient entries:** add that every wrap is derived from the CEK (§3.3), so the sender has no free choice per entry.
- **§3.1.1, Owner read, step 4:** `unwrapCek`, then the `kc` check inside the payload decryption, then the recomputation of the agent entries whose keys the owner knows.
- **§3.1.1, Verification:**
  - step 5 adds the `kc` check and the recomputation of the own owner's entry and of every other entry whose key the core knows from cards; a mismatch is `open_failed`, stored as refused and flagged;
  - step 8 becomes "present and carries the committed CEK (step 5)", and its last sentence is deleted.
- **§3.1.1, Size table, `aead.ct` row:** the worst case becomes 24 563 bytes; the cap stays 17 152; add a note that any later envelope field must lower the cap by 64.
- **§3.3:**
  - replace "the construction is open" with the construction (D's `ikm_j`, `DeriveKeyPair`, SealBase; A's `encKey` and `kc`);
  - add the one-plaintext argument in two sentences;
  - add the rule that the wrap HPKE context is used for the CEK seal only;
  - keep the requirement sentence and cite the new D-number.
- **§4:** one sentence saying that files inherit the guarantee through `fileKey`, `ciphertextSha256` and `plaintextSha256` in the committed payload, and that both hash checks are mandatory.
- **§7**, new row: "Malicious sender equivocates across recipients (two-key ciphertext, per-entry keys, owner exclusion)", mitigated by `kc` (§3.1) and wrap recomputation (§3.3).

**07-sdk-transport-storage.md**
- **§6.2**, `verifyProofPack`: "decrypt with the disclosed key only after it matches `aead.kc`".
- **§8:**
  - `disclosure` non-null requires `envelope`;
  - `contentKey` is the 32-byte CEK;
  - verifier order: recompute `envelopeHash` and compare; verify `sig` under `from`; derive and compare `kc`; decrypt;
  - optionally check the counterparty's entry against its card (D).

**00-README.md:** a new decision (next free: D-63) recording the construction, and the version-table line.

**backlog.md:**
- G-46 becomes RESOLVED by the new decision.
- New or follow-up cards:
  - M1-1c follow-up: `aead.ts`, `envelope.ts` and `hpke.ts`, plus the `checkWrap` helper;
  - M1-2a follow-up: `aeadSchema` and fixtures;
  - M1-1h: regenerate `aead-envelope` and `safety-code-recompute`, add `hpke` derived-ephemeral cases and the `kc` reject cases, then freeze;
  - M1-5a: test fixtures.
- Scope lines: M1-7b (steps 5 and 8, T2/T3 refusal tests), M1-4d and M1-7g (pack rules), DOCS-M1a (`docs-site/technical/concepts/envelopes.md`, `docs-site/technical/reference/proof-pack-format.md`).
- Drop "gap G-46 resolved" from Depends on in M1-1h, M1-7b and M1-7g.

**CHANGELOG.md:** a spec line under `[Unreleased]`.

## 6. Decisions for the owner

1. **Construction:** adopt Option A (HKDF-derived payload key plus `aead.kc`, checked before decrypting) as the G-46 construction? *Recommended: yes.*
2. **Owner exclusion:** adopt Option D now (derived ephemeral keys; every opener checks its owner's entry and every entry it knows)? Or record T3 as a separate I-9 gap and accept that fixing it later needs envelope v2? *Recommended: adopt now.*
3. **Wire form:**
   - `kc` inside `aead` (signed, outside the AAD) rather than a top-level header field in the AAD;
   - `alg` renamed to `A256GCM-KC`;
   - `v` stays 1, because nothing is released.

   *Recommended: as stated.*
4. **Proof packs:** `envelope` mandatory whenever `disclosure` is present; `contentKey` stays the CEK; the counterparty-entry check is optional for verifiers. *Recommended: yes.*
5. **Size budget:** keep the `ct` cap at 17 152 (worst case 24 563 of 24 576, 13 bytes of headroom). Any future envelope field lowers the cap. *Recommended: yes.*
6. **T6** (different envelopes under one `id` per recipient at the transport): record it as a new gap (G-48; numbered G-47 before that number went to FA-2) for a separate design, for example the receiving agent reporting `envelopeHash` to its owner in the F-23 ack. *Recommended: record it.*
7. **Review:** an independent Opus review of the spec PR (S2, audit-rules §4), with the construction added explicitly to the M3-1 external audit scope. *Recommended: yes.*
