#!/usr/bin/env python3
"""Independent generator for the `aead-envelope` suite: envelope hash, payload AEAD, signature (M1-1h,
regenerated for key commitment by M1-1l: G-46, D-66).

04 §3.1 and §3.3, exactly:
  envelopeHash = sha256(JCS(envelope without "sig"))                       (RFC 8785)
  AEAD AAD     = sha256(JCS({v, id, thread, from, createdAt, recipients}))   (the 32 raw bytes)
  encKey       = HKDF-SHA256(ikm = CEK, salt = "", info = utf8("agentlink/v1/payload-key") || id, 32)
  kc           = HKDF-SHA256(ikm = CEK, salt = "", info = utf8("agentlink/v1/payload-commit") || id, 32)
  aead         = { alg: "A256GCM-KC", iv (12 bytes), kc, ct: AES-256-GCM(encKey, iv, AAD, payload) }
  decryption   = compare kc first (a mismatch fails like a bad tag), then AES-256-GCM under encKey
  sig          = BIP-340 by `from` over taggedHash("agentlink/envelope/v1", envelopeHash)
`id` is the envelope id as its raw 16 bytes. JCS is Trail of Bits' `rfc8785` (checked against RFC
8785 in the `jcs` suite), HKDF and AES-GCM are `cryptography` (HKDF cross-checked against RFC 5869
written out over hashlib HMAC), BIP-340 is libsecp256k1 (coincurve, checked against the BIP in
`bip340`). The recipients carry real CEK wraps with ephemeral keys derived from the CEK (04 §3.3, as
in the `hpke` suite). Keys, ids, the CEK, the IV and aux_rand are synthetic test values.

Cases: the payload-key and payload-commit derivations (`deriveFromCek`); hash, AAD, encrypt,
decrypt, the commitment check (`checkCommitment`), sign and verify. Negative cases (M1-1c, M1-1l
acceptance): changing any covered field (createdAt, recipient order, thread, id, aead.ct) or the
CEK or IV fails decryption or verification; a `kc` with one bit flipped, missing, of 31 or 33
bytes, the old alg `A256GCM` and the whole earlier envelope form are refused; a two-key ciphertext
(one `ct` whose GCM tag is valid under the encKeys of two CEKs, built by solving the GHASH equation
and confirmed with `cryptography`) opens only under the CEK its `kc` commits to; a signature by
another key, over the untagged hash, or under the owner-action tag (04 §2.5.1) does not verify.

Usage: python3 -I tools/vectors/generate_aead_envelope.py --check [FILE] | --write
"""

import copy
import hmac
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import generate_hpke as hpke  # noqa: E402
import vectorlib as v  # noqa: E402

SUITE = "aead-envelope"
VERSION = 2
ENVELOPE_TAG = "agentlink/envelope/v1"
OWNER_ACTION_TAG = "agentlink/owner-action/v1"
AEAD_ALG = "A256GCM-KC"
OLD_AEAD_ALG = "A256GCM"
HEADER_FIELDS = ["v", "id", "thread", "from", "createdAt", "recipients"]
STRUCTURE = "04 §3.1 envelope v1 structure, §2.4.1 encodings, strict schema (M1-2a)"
SPEC_KC = "04 §3.1, §3.3 key commitment (G-46, D-66)"
ROLES = ["recipient-agent", "recipient-owner", "sender-owner", "sender-agent"]
DELETE = object()


def header(envelope):
    return {k: envelope[k] for k in HEADER_FIELDS}


def aad_of(envelope):
    return v.sha256(v.jcs(header(envelope)))


def envelope_hash(envelope):
    return v.sha256(v.jcs_lenient({k: val for k, val in envelope.items() if k != "sig"}))


def b64u_len(text, n=None, minimum=None):
    data = v.unb64u(text)
    if (n is not None and len(data) != n) or (minimum is not None and len(data) < minimum):
        raise ValueError("wrong length")
    return data


def payload_key(cek, envelope_id):
    return v.derive_from_cek(v.PAYLOAD_KEY_LABEL, cek, envelope_id)


def payload_commit(cek, envelope_id):
    return v.derive_from_cek(v.PAYLOAD_COMMIT_LABEL, cek, envelope_id)


def encrypt_payload(head, cek, iv, plaintext):
    """04 §3.3 payload encryption: the `aead` object for a header, CEK, IV and payload."""
    envelope_id = v.unb64u(head["id"])
    ct = v.aes256gcm_encrypt(payload_key(cek, envelope_id), iv, plaintext, aad_of(head))
    return {"alg": AEAD_ALG, "iv": v.b64u(iv), "kc": v.b64u(payload_commit(cek, envelope_id)), "ct": v.b64u(ct)}


def check_commitment(envelope, cek):
    """04 §3.3 step 1: aead.kc equals the kc derived from the CEK (constant-time compare)."""
    try:
        kc = v.unb64u(envelope["aead"]["kc"])
        return hmac.compare_digest(kc, payload_commit(cek, v.unb64u(envelope["id"])))
    except Exception:
        return False


def validate(envelope):
    """Envelope v1 structure and encodings (04 §3.1, §2.4.1; strict
    schema, unknown keys rejected, M1-2a), then the signature. Returns True only if all hold."""
    try:
        if set(envelope) != {"v", "id", "thread", "from", "createdAt", "recipients", "aead", "sig"}:
            return False
        if envelope["v"] != 1 or isinstance(envelope["v"], bool):
            return False
        b64u_len(envelope["id"], 16)
        b64u_len(envelope["thread"], 16)
        if not isinstance(envelope["from"], str) or not re.fullmatch(r"[0-9a-f]{64}", envelope["from"]):
            return False
        t = envelope["createdAt"]
        if isinstance(t, bool) or not isinstance(t, int) or not 0 <= t <= 2**53 - 1:
            return False
        recipients = envelope["recipients"]
        if not isinstance(recipients, list) or not recipients:
            return False
        for r in recipients:
            if set(r) != {"kid", "enc", "wk"}:
                return False
            b64u_len(r["kid"], 16)
            b64u_len(r["enc"], 32)
            b64u_len(r["wk"], 48)
        a = envelope["aead"]
        if set(a) != {"alg", "iv", "kc", "ct"} or a["alg"] != AEAD_ALG:
            return False
        b64u_len(a["iv"], 12)
        b64u_len(a["kc"], 32)
        b64u_len(a["ct"], minimum=16)
        if not isinstance(envelope["sig"], str) or not re.fullmatch(r"[0-9a-f]{128}", envelope["sig"]):
            return False
    except (ValueError, KeyError, TypeError, AttributeError):
        return False
    return verify(envelope)


def sign(envelope, secret, aux, tag=ENVELOPE_TAG, tagged=True):
    digest = envelope_hash(envelope)
    message = v.tagged_hash(tag, digest) if tagged else digest
    return v.schnorr_sign(secret, message, aux)


def verify(envelope):
    try:
        sig = bytes.fromhex(envelope["sig"])
        public = bytes.fromhex(envelope["from"])
    except (KeyError, ValueError):
        return False
    return v.schnorr_verify(public, v.tagged_hash(ENVELOPE_TAG, envelope_hash(envelope)), sig)


def decrypt(envelope, cek):
    """04 §3.3 payload decryption: the kc check, then AES-256-GCM under encKey. None on failure."""
    if not check_commitment(envelope, cek):
        return None
    try:
        key = payload_key(cek, v.unb64u(envelope["id"]))
        return v.aes256gcm_decrypt(key, v.unb64u(envelope["aead"]["iv"]), v.unb64u(envelope["aead"]["ct"]), aad_of(envelope))
    except Exception:
        return None


# --- a two-key AES-GCM ciphertext (only to build the G-46 attack case) ---------------------------
# GF(2^128) as in NIST SP 800-38D §6.3 (bit 0 of a block is the most significant bit of the
# integer). The result is checked with `cryptography`'s AES-GCM under both keys before it is used.

_R = 0xE1 << 120


def _gf_mul(x, y):
    z = 0
    for i in range(127, -1, -1):
        if (x >> i) & 1:
            z ^= y
        y = (y >> 1) ^ _R if y & 1 else y >> 1
    return z


def _gf_inv(x):
    result, base, e = 1 << 127, x, 2**128 - 2  # 1 << 127 is the field's one
    while e:
        if e & 1:
            result = _gf_mul(result, base)
        base = _gf_mul(base, base)
        e >>= 1
    return result


def _aes_block(key, block):
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

    return Cipher(algorithms.AES(bytes(key)), modes.ECB()).encryptor().update(bytes(block))


def _blocks(data):
    data = bytes(data) + bytes(-len(data) % 16)
    return [int.from_bytes(data[i : i + 16], "big") for i in range(0, len(data), 16)]


def _ghash(h, aad, ct):
    y = 0
    lengths = ((8 * len(aad)) << 64) | (8 * len(ct))
    for block in _blocks(aad) + _blocks(ct) + [lengths]:
        y = _gf_mul(y ^ block, h)
    return y


def two_key_ciphertext(key1, key2, iv, aad, first_block):
    """ct || tag of 32 + 16 bytes that AES-256-GCM opens under key1 and key2 (same iv, aad).
    The second ciphertext block C solves GHASH_1 ^ E1(J0) = GHASH_2 ^ E2(J0); with the lengths
    block last, C is multiplied by H^2."""
    h1, h2 = (int.from_bytes(_aes_block(k, bytes(16)), "big") for k in (key1, key2))
    j0 = bytes(iv) + (1).to_bytes(4, "big")
    s1, s2 = (int.from_bytes(_aes_block(k, j0), "big") for k in (key1, key2))
    zero = bytes(first_block) + bytes(16)
    rhs = s1 ^ s2 ^ _ghash(h1, aad, zero) ^ _ghash(h2, aad, zero)
    c = _gf_mul(rhs, _gf_inv(_gf_mul(h1, h1) ^ _gf_mul(h2, h2)))
    ct = bytes(first_block) + c.to_bytes(16, "big")
    tag = (s1 ^ _ghash(h1, aad, ct)).to_bytes(16, "big")
    out = ct + tag
    p1 = v.aes256gcm_decrypt(key1, iv, out, aad)  # raises unless the tag is valid
    p2 = v.aes256gcm_decrypt(key2, iv, out, aad)
    if p1 == p2:
        v.fail("the two-key ciphertext gives one plaintext")
    return out


def recipients_for(envelope_id, ceks_by_role, label):
    out = []
    for role in ROLES:
        public = v.x25519_public_key(v.det(f"{label}/{role}/enc", 32))
        enc, wk = hpke.wrap_cek(public, envelope_id, ceks_by_role[role])
        out.append({"kid": v.b64u(v.sha256(public)[:16]), "enc": v.b64u(enc), "wk": v.b64u(wk)})
    return out


def build():
    sender = v.det("aead-envelope/sender-agent/nostr", 32)
    other = v.det("aead-envelope/other-key/nostr", 32)
    cek = v.det("aead-envelope/cek", 32)
    iv = v.det("aead-envelope/iv", 12)
    aux = v.det("aead-envelope/aux-rand", 32)
    envelope_id = v.det("aead-envelope/id", 16)
    plaintext = v.jcs({"type": "text", "body": "Hello from the AgentLink test vectors ✓", "replyTo": None, "files": []})

    env = {
        "v": 1,
        "id": v.b64u(envelope_id),
        "thread": v.b64u(v.det("aead-envelope/thread", 16)),
        "from": v.hx(v.xonly_public_key(sender)),
        "createdAt": 1760000000,
        "recipients": recipients_for(envelope_id, {r: cek for r in ROLES}, "aead-envelope"),
    }
    env["aead"] = encrypt_payload(env, cek, iv, plaintext)
    unsigned = copy.deepcopy(env)
    env["sig"] = v.hx(sign(env, sender, aux))
    if not verify(env) or decrypt(env, cek) != plaintext:
        v.fail("the reference envelope does not verify or decrypt")
    enc_key, kc = payload_key(cek, envelope_id), payload_commit(cek, envelope_id)
    if enc_key == kc or enc_key == cek or kc == cek:
        v.fail("encKey, kc and the CEK are not distinct")
    if v.aes256gcm_encrypt(cek, iv, plaintext, aad_of(env)) == v.unb64u(env["aead"]["ct"]):
        v.fail("the payload is encrypted under the CEK")

    cases = []
    for label, okm in [(v.PAYLOAD_KEY_LABEL, enc_key), (v.PAYLOAD_COMMIT_LABEL, kc)]:
        name = label.rsplit("/", 1)[1]
        cases.append(
            v.case(
                f"derive-{name}",
                f"{SPEC_KC}: HKDF-SHA256(CEK, salt \"\", utf8(\"{label}\") || id), 32 bytes, for the reference envelope",
                {"op": "deriveFromCek", "label": label, "cek": v.hx(cek), "envelopeId": env["id"]},
                {"okm": v.hx(okm)},
            )
        )
    for case_id, why, label, the_cek, env_id in [
        ("derive-reject-payload-key-id-15-bytes", "payload-key with a 15-byte envelope id", v.PAYLOAD_KEY_LABEL, cek, envelope_id[:15]),
        ("derive-reject-payload-commit-cek-33-bytes", "payload-commit with a 33-byte CEK", v.PAYLOAD_COMMIT_LABEL, cek + bytes(1), envelope_id),
    ]:
        try:
            v.derive_from_cek(label, the_cek, env_id)
            v.fail(f"{case_id} derives")
        except ValueError:
            pass
        cases.append(v.case(case_id, f"{SPEC_KC}: {why}; refused", {"op": "deriveFromCek", "label": label, "cek": v.hx(the_cek), "envelopeId": v.b64u(env_id)}, {"outcome": "reject"}))

    cases += [
        v.case(
            "envelope-hash",
            "04 §3.1 envelopeHash = sha256(JCS(envelope without sig))",
            {"op": "envelopeHash", "envelope": env},
            {"envelopeHash": v.hx(envelope_hash(env))},
        ),
        v.case(
            "envelope-hash-unsigned",
            "04 §3.1 envelopeHash of the same envelope before signing (equal to envelope-hash)",
            {"op": "envelopeHash", "envelope": unsigned},
            {"envelopeHash": v.hx(envelope_hash(unsigned))},
        ),
        v.case(
            "aad",
            "04 §3.1 AAD = sha256(JCS({v, id, thread, from, createdAt, recipients}))",
            {"op": "aad", "envelope": env},
            {"aad": v.hx(aad_of(env))},
        ),
        v.case(
            "encrypt-payload",
            f"{SPEC_KC} payload AEAD: AES-256-GCM under encKey (fixed IV), kc from the CEK",
            {"op": "encryptPayload", "header": header(env), "cek": v.hx(cek), "iv": v.b64u(iv), "plaintext": v.hx(plaintext)},
            {"aad": v.hx(aad_of(env)), "kc": env["aead"]["kc"], "ct": env["aead"]["ct"]},
        ),
        v.case(
            "decrypt-payload",
            f"{SPEC_KC} payload AEAD open: the kc check, then AES-256-GCM under encKey",
            {"op": "decryptPayload", "envelope": env, "cek": v.hx(cek)},
            {"plaintext": v.hx(plaintext)},
        ),
        v.case(
            "check-commitment",
            f"{SPEC_KC}: aead.kc matches the kc derived from the CEK",
            {"op": "checkCommitment", "envelope": env, "cek": v.hx(cek)},
            {"outcome": "accept"},
        ),
        v.case(
            "sign",
            "04 §3.1 sig = BIP-340 over taggedHash(\"agentlink/envelope/v1\", envelopeHash)",
            {"op": "sign", "envelope": unsigned, "secretKey": v.hx(sender), "auxRand": v.hx(aux)},
            {
                "envelopeHash": v.hx(envelope_hash(unsigned)),
                "signatureInput": v.hx(v.tagged_hash(ENVELOPE_TAG, envelope_hash(unsigned))),
                "sig": env["sig"],
            },
        ),
        v.case("verify", "04 §3.1 signature verifies against `from`", {"op": "verify", "envelope": env}, {"outcome": "accept"}),
    ]
    if envelope_hash(unsigned) != envelope_hash(env):
        v.fail("sig is not excluded from the envelope hash")

    # Covered-field changes: a different hash, and neither decryption nor verification succeeds.
    def mutated(case_id, why, change):
        m = copy.deepcopy(env)
        change(m)
        if envelope_hash(m) == envelope_hash(env):
            v.fail(f"{case_id}: hash unchanged")
        return m, why

    mutations = [
        mutated("created-at", "createdAt + 1", lambda m: m.__setitem__("createdAt", m["createdAt"] + 1)),
        mutated("recipients-reordered", "recipient order reversed", lambda m: m["recipients"].reverse()),
        mutated("thread", "another thread", lambda m: m.__setitem__("thread", v.b64u(v.det("aead-envelope/other-thread", 16)))),
        mutated("id", "another id (kc and encKey are bound to the id)", lambda m: m.__setitem__("id", v.b64u(v.det("aead-envelope/other-id", 16)))),
    ]
    for (m, why), name in zip(mutations, ["created-at", "recipients-reordered", "thread", "id"]):
        cases.append(
            v.case(f"envelope-hash-{name}", f"04 §3.1 envelopeHash changes with {why}", {"op": "envelopeHash", "envelope": m}, {"envelopeHash": v.hx(envelope_hash(m))})
        )
        if decrypt(m, cek) is not None or verify(m):
            v.fail(f"{name}: still decrypts or verifies")
        cases.append(v.case(f"decrypt-reject-{name}", f"04 §3.1 AAD binds the header: {why}", {"op": "decryptPayload", "envelope": m, "cek": v.hx(cek)}, {"outcome": "reject"}))
        cases.append(v.case(f"verify-reject-{name}", f"04 §3.1 signature covers the header: {why}", {"op": "verify", "envelope": m}, {"outcome": "reject"}))
    if check_commitment(mutations[3][0], cek):
        v.fail("kc is not bound to the id")
    cases.append(v.case("check-commitment-reject-id", f"{SPEC_KC}: kc is bound to the envelope id", {"op": "checkCommitment", "envelope": mutations[3][0], "cek": v.hx(cek)}, {"outcome": "reject"}))

    def aead_variant(change):
        m = copy.deepcopy(env)
        change(m["aead"])
        return m

    ct_bytes = v.unb64u(env["aead"]["ct"])
    kc_bytes = v.unb64u(env["aead"]["kc"])
    flipped_tag = aead_variant(lambda a: a.__setitem__("ct", v.b64u(hpke.flip(ct_bytes, len(ct_bytes) - 1))))
    flipped_ct = aead_variant(lambda a: a.__setitem__("ct", v.b64u(hpke.flip(ct_bytes, 0))))
    other_iv = aead_variant(lambda a: a.__setitem__("iv", v.b64u(v.det("aead-envelope/other-iv", 12))))
    flipped_kc = aead_variant(lambda a: a.__setitem__("kc", v.b64u(hpke.flip(kc_bytes, 0))))
    missing_kc = aead_variant(lambda a: a.pop("kc"))
    kc_31 = aead_variant(lambda a: a.__setitem__("kc", v.b64u(kc_bytes[:31])))
    kc_33 = aead_variant(lambda a: a.__setitem__("kc", v.b64u(kc_bytes + bytes(1))))
    other_cek = v.det("aead-envelope/other-cek", 32)
    # The flipped kc fails only the commitment: GCM under the right encKey would still open.
    if v.aes256gcm_decrypt(enc_key, iv, ct_bytes, aad_of(flipped_kc)) != plaintext:
        v.fail("the flipped-kc envelope is not otherwise intact")
    for case_id, why, m, key in [
        ("decrypt-reject-tag-flipped", "tampered tag", flipped_tag, cek),
        ("decrypt-reject-ct-flipped", "tampered ciphertext", flipped_ct, cek),
        ("decrypt-reject-other-iv", "another IV", other_iv, cek),
        ("decrypt-reject-wrong-cek", "another CEK (its kc does not match)", env, other_cek),
        ("decrypt-reject-kc-flipped", "kc with one bit flipped; GCM under encKey would open, the kc check refuses", flipped_kc, cek),
        ("decrypt-reject-missing-kc", "aead without kc", missing_kc, cek),
        ("decrypt-reject-kc-31-bytes", "kc of 31 bytes (the 31-byte prefix of the right kc)", kc_31, cek),
        ("decrypt-reject-kc-33-bytes", "kc of 33 bytes (the right kc and one zero byte)", kc_33, cek),
    ]:
        if decrypt(m, key) is not None:
            v.fail(f"{case_id} decrypts")
        cases.append(v.case(case_id, f"{SPEC_KC} payload decryption: {why}", {"op": "decryptPayload", "envelope": m, "cek": v.hx(key)}, {"outcome": "reject"}))
    for case_id, why, m, key in [
        ("check-commitment-reject-wrong-cek", "another CEK", env, other_cek),
        ("check-commitment-reject-kc-flipped", "kc with one bit flipped", flipped_kc, cek),
        ("check-commitment-reject-missing-kc", "aead without kc", missing_kc, cek),
        ("check-commitment-reject-kc-31-bytes", "kc of 31 bytes", kc_31, cek),
        ("check-commitment-reject-kc-33-bytes", "kc of 33 bytes", kc_33, cek),
    ]:
        if check_commitment(m, key):
            v.fail(f"{case_id} passes")
        cases.append(v.case(case_id, f"{SPEC_KC}: {why}", {"op": "checkCommitment", "envelope": m, "cek": v.hx(key)}, {"outcome": "reject"}))
    for case_id, why, m in [("ct-flipped", "aead.ct", flipped_ct), ("kc-flipped", "aead.kc", flipped_kc)]:
        if verify(m):
            v.fail(f"{why} is not covered by the signature")
        cases.append(v.case(f"verify-reject-{case_id}", f"04 §3.1, §3.1.1 the signature covers {why}", {"op": "verify", "envelope": m}, {"outcome": "reject"}))

    # The earlier envelope form (alg A256GCM, no kc, AES-GCM directly under the CEK), signed.
    old = copy.deepcopy(unsigned)
    old["aead"] = {"alg": OLD_AEAD_ALG, "iv": v.b64u(iv), "ct": v.b64u(v.aes256gcm_encrypt(cek, iv, plaintext, aad_of(old)))}
    old["sig"] = v.hx(sign(old, sender, aux))
    if not verify(old) or decrypt(old, cek) is not None:
        v.fail("the earlier-form envelope is not a clean old-form case")
    cases.append(v.case("decrypt-reject-earlier-form", f"{SPEC_KC}: the earlier form (alg A256GCM, no kc, GCM under the CEK) is not opened", {"op": "decryptPayload", "envelope": old, "cek": v.hx(cek)}, {"outcome": "reject"}))

    # Two-key ciphertext (G-46 T1): one ct whose GCM tag is valid under the encKeys of two CEKs.
    # The sender wraps the second CEK to the recipient agent and the first to everyone else, and
    # commits kc to the first. Only the committed CEK opens it.
    tk_id = v.det("aead-envelope/two-key/id", 16)
    tk_iv = v.det("aead-envelope/two-key/iv", 12)
    cek_a, cek_b = v.det("aead-envelope/two-key/cek-a", 32), v.det("aead-envelope/two-key/cek-b", 32)
    tk = {
        "v": 1,
        "id": v.b64u(tk_id),
        "thread": env["thread"],
        "from": env["from"],
        "createdAt": 1760000200,
        "recipients": recipients_for(tk_id, {r: (cek_b if r == "recipient-agent" else cek_a) for r in ROLES}, "aead-envelope"),
    }
    key_a, key_b = payload_key(cek_a, tk_id), payload_key(cek_b, tk_id)
    tk_ct = two_key_ciphertext(key_a, key_b, tk_iv, aad_of(tk), v.det("aead-envelope/two-key/first-block", 16))
    tk["aead"] = {"alg": AEAD_ALG, "iv": v.b64u(tk_iv), "kc": v.b64u(payload_commit(cek_a, tk_id)), "ct": v.b64u(tk_ct)}
    tk["sig"] = v.hx(sign(tk, sender, aux))
    plaintext_a = decrypt(tk, cek_a)
    if not validate(tk) or plaintext_a is None or decrypt(tk, cek_b) is not None:
        v.fail("the two-key envelope does not behave as intended")
    if v.aes256gcm_decrypt(key_b, tk_iv, tk_ct, aad_of(tk)) is None:
        v.fail("the two-key ciphertext does not open under the second encKey")
    two_key = "a two-key ciphertext (its GCM tag is valid under the encKeys of both CEKs; kc commits to the first)"
    cases += [
        v.case("validate-two-key", f"{STRUCTURE}: {two_key} is well formed and signed, so only kc can refuse it", {"op": "validate", "envelope": tk}, {"outcome": "accept"}),
        v.case("decrypt-two-key-committed-cek", f"{SPEC_KC}: {two_key}, opened with the committed CEK", {"op": "decryptPayload", "envelope": tk, "cek": v.hx(cek_a)}, {"plaintext": v.hx(plaintext_a)}),
        v.case("decrypt-reject-two-key-other-cek", f"{SPEC_KC}: {two_key}, opened with the other CEK: GCM would open, the kc check refuses", {"op": "decryptPayload", "envelope": tk, "cek": v.hx(cek_b)}, {"outcome": "reject"}),
        v.case("check-commitment-two-key-committed-cek", f"{SPEC_KC}: {two_key}, the committed CEK", {"op": "checkCommitment", "envelope": tk, "cek": v.hx(cek_a)}, {"outcome": "accept"}),
        v.case("check-commitment-reject-two-key-other-cek", f"{SPEC_KC}: {two_key}, the other CEK", {"op": "checkCommitment", "envelope": tk, "cek": v.hx(cek_b)}, {"outcome": "reject"}),
    ]

    def resigned(**kwargs):
        m = copy.deepcopy(env)
        m["sig"] = v.hx(sign(m, **kwargs))
        return m

    other_signer = resigned(secret=other, aux=aux)
    other_from = copy.deepcopy(other_signer)
    other_from["from"] = v.hx(v.xonly_public_key(other))
    for case_id, why, m in [
        ("verify-reject-other-signer", "signed by another key than `from`", other_signer),
        ("verify-reject-untagged", "signed over envelopeHash without the tag", resigned(secret=sender, aux=aux, tagged=False)),
        ("verify-reject-owner-action-tag", "signed under agentlink/owner-action/v1", resigned(secret=sender, aux=aux, tag=OWNER_ACTION_TAG)),
        ("verify-reject-from-swapped", "`from` replaced by the signer's key after signing (from is covered)", other_from),
    ]:
        if verify(m):
            v.fail(f"{case_id} verifies")
        cases.append(v.case(case_id, f"04 §3.1: {why}", {"op": "verify", "envelope": m}, {"outcome": "reject"}))

    # Structure and encodings (IR-M1-1h-1 F4). Each variant is re-signed by `from`, so the
    # signature is valid and only the structure or encoding check can refuse it.
    if not validate(env):
        v.fail("the reference envelope does not validate")
    cases.append(v.case("validate", f"{STRUCTURE}: the reference envelope", {"op": "validate", "envelope": env}, {"outcome": "accept"}))

    def variant(change, resign=True):
        m = copy.deepcopy(env)
        change(m)
        if resign:
            m["sig"] = v.hx(sign(m, sender, aux))
        return m

    def set_path(*path_and_value):
        *path, value = path_and_value

        def change(m):
            target = m
            for key in path[:-1]:
                target = target[key]
            if value is DELETE:
                del target[path[-1]]
            else:
                target[path[-1]] = value

        return change

    first_with_url_chars = next(i for i, r in enumerate(env["recipients"]) if "-" in r["wk"] or "_" in r["wk"])
    standard_alphabet = env["recipients"][first_with_url_chars]["wk"].replace("-", "+").replace("_", "/")
    id_bytes = v.unb64u(env["id"])
    for case_id, why, m in [
        ("v-2", "v other than 1", variant(set_path("v", 2))),
        ("unknown-top-level-key", "an unknown top-level key", variant(set_path("note", "x"))),
        ("unknown-aead-key", "an unknown key in aead", variant(set_path("aead", "tag", "x"))),
        ("unknown-recipient-key", "an unknown key in a recipient", variant(set_path("recipients", 0, "note", "x"))),
        ("missing-thread", "thread missing", variant(set_path("thread", DELETE))),
        ("id-15-bytes", "id of 15 bytes", variant(set_path("id", v.b64u(id_bytes[:15])))),
        ("id-padded", "id as padded base64url", variant(set_path("id", env["id"] + "=="))),
        ("thread-17-bytes", "thread of 17 bytes", variant(set_path("thread", v.b64u(v.unb64u(env["thread"]) + bytes(1))))),
        ("from-uppercase", "from in upper-case hex", variant(set_path("from", env["from"].upper()))),
        ("from-0x-prefix", "from with 0x (Nostr-native: bare hex)", variant(set_path("from", "0x" + env["from"]))),
        ("created-at-2-pow-53", "createdAt = 2^53", variant(set_path("createdAt", 2**53))),
        ("created-at-string", "createdAt as a string", variant(set_path("createdAt", str(env["createdAt"])))),
        ("recipients-empty", "no recipients", variant(set_path("recipients", []))),
        ("kid-15-bytes", "kid of 15 bytes", variant(set_path("recipients", 0, "kid", v.b64u(v.unb64u(env["recipients"][0]["kid"])[:15])))),
        ("wk-standard-alphabet", "wk with + and / (standard base64)", variant(set_path("recipients", first_with_url_chars, "wk", standard_alphabet))),
        ("alg-a128gcm", "alg other than A256GCM-KC", variant(set_path("aead", "alg", "A128GCM"))),
        ("alg-a256gcm", "the earlier alg A256GCM, with kc present", variant(set_path("aead", "alg", OLD_AEAD_ALG))),
        ("missing-kc", "aead without kc", variant(set_path("aead", "kc", DELETE))),
        ("kc-31-bytes", "kc of 31 bytes", variant(set_path("aead", "kc", v.b64u(kc_bytes[:31])))),
        ("kc-33-bytes", "kc of 33 bytes", variant(set_path("aead", "kc", v.b64u(kc_bytes + bytes(1))))),
        ("kc-padded", "kc as padded base64url", variant(set_path("aead", "kc", env["aead"]["kc"] + "="))),
        ("kc-hex", "kc as hex instead of base64url", variant(set_path("aead", "kc", kc_bytes.hex()))),
        ("iv-11-bytes", "iv of 11 bytes", variant(set_path("aead", "iv", v.b64u(v.unb64u(env["aead"]["iv"])[:11])))),
        ("iv-padded", "iv as padded base64url", variant(set_path("aead", "iv", env["aead"]["iv"] + "="))),
        ("ct-15-bytes", "ct shorter than the 16-byte tag", variant(set_path("aead", "ct", v.b64u(v.unb64u(env["aead"]["ct"])[:15])))),
        ("earlier-form", "the earlier form: aead {alg A256GCM, iv, ct} without kc, GCM under the CEK", old),
        ("sig-uppercase", "sig in upper-case hex (the signature is otherwise valid)", variant(set_path("sig", env["sig"].upper()), resign=False)),
        ("sig-0x-prefix", "sig with 0x", variant(set_path("sig", "0x" + env["sig"]), resign=False)),
    ]:
        if validate(m):
            v.fail(f"validate-reject-{case_id} validates")
        if (case_id.startswith(("kc-", "alg-", "missing-kc")) or case_id == "earlier-form") and not verify(m):
            v.fail(f"validate-reject-{case_id}: the signature is not valid, so the structure check is not isolated")
        cases.append(v.case(f"validate-reject-{case_id}", f"{STRUCTURE}: {why}; rejected, never normalised", {"op": "validate", "envelope": m}, {"outcome": "reject"}))
    return cases


SCHEMA = v.case_schema(
    SUITE,
    "04 §3.1, §3.3 envelope with key commitment (G-46, D-66). `deriveFromCek`: the payload-key or "
    "payload-commit derivation (HKDF-SHA256, ikm = CEK, empty salt, info = utf8(label) || raw 16-byte "
    "id) or a refusal. `envelopeHash`, `aad`: hashes of the given envelope. `encryptPayload`: AAD, "
    "base64url kc and base64url ct||tag (AES-256-GCM under encKey) for header, CEK, IV and plaintext. "
    "`decryptPayload`: plaintext or rejection (kc checked first). `checkCommitment`: whether aead.kc "
    "is the kc of the CEK. `sign`: envelopeHash, tagged signature input and sig. `verify`: accept or "
    "reject. `validate`: structure, encodings and signature together (strict).",
    {
        "deriveFromCek": ({"label": v.STRING, "cek": v.HEX, "envelopeId": v.B64U}, [{"okm": v.hexn(32)}, v.REJECT]),
        "envelopeHash": ({"envelope": v.OBJECT}, [{"envelopeHash": v.hexn(32)}]),
        "aad": ({"envelope": v.OBJECT}, [{"aad": v.hexn(32)}]),
        "encryptPayload": (
            {"header": v.OBJECT, "cek": v.hexn(32), "iv": v.B64U, "plaintext": v.HEX},
            [{"aad": v.hexn(32), "kc": v.B64U, "ct": v.B64U}],
        ),
        "decryptPayload": ({"envelope": v.OBJECT, "cek": v.hexn(32)}, [{"plaintext": v.HEX}, v.REJECT]),
        "checkCommitment": ({"envelope": v.OBJECT, "cek": v.hexn(32)}, [v.ACCEPT, v.REJECT]),
        "sign": (
            {"envelope": v.OBJECT, "secretKey": v.hexn(32), "auxRand": v.hexn(32)},
            [{"envelopeHash": v.hexn(32), "signatureInput": v.hexn(32), "sig": v.hexn(64)}],
        ),
        "verify": ({"envelope": v.OBJECT}, [v.ACCEPT, v.REJECT]),
        "validate": ({"envelope": v.OBJECT}, [v.ACCEPT, v.REJECT]),
    },
)

if __name__ == "__main__":
    v.main(
        suite=SUITE,
        version=VERSION,
        script="tools/vectors/generate_aead_envelope.py",
        libraries=["cryptography", "coincurve", "pyhpke", "rfc8785"],
        build=build,
        schema=SCHEMA,
        doc=__doc__,
    )
