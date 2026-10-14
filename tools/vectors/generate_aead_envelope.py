#!/usr/bin/env python3
"""Independent generator for the `aead-envelope` suite: envelope hash, payload AEAD, signature (M1-1h).

04 §3.1, exactly:
  envelopeHash = sha256(JCS(envelope without "sig"))                       (RFC 8785)
  AEAD AAD     = sha256(JCS({v, id, thread, from, createdAt, recipients}))   (the 32 raw bytes)
  aead         = AES-256-GCM(CEK, iv (12 bytes), payload) -> ct || 16-byte tag, base64url
  sig          = BIP-340 by `from` over taggedHash("agentlink/envelope/v1", envelopeHash)
JCS is Trail of Bits' `rfc8785` (checked against RFC 8785 in the `jcs` suite), AES-GCM is
`cryptography`, BIP-340 is libsecp256k1 (coincurve, checked against the BIP in `bip340`). The
recipients carry real CEK wraps (04 §3.3, as in the `hpke` suite) under fixed ephemeral keys.
Keys, ids, the CEK, the IV and aux_rand are synthetic test values.

Negative cases (M1-1c acceptance): changing any covered field (createdAt, recipient order, thread,
aead.ct) or the CEK or IV fails decryption or verification; a signature by another key, over the
untagged hash, or under the owner-action tag (04 §2.5.1) does not verify.

Usage: python3 -I tools/vectors/generate_aead_envelope.py --check [FILE] | --write
"""

import copy
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import generate_hpke as hpke  # noqa: E402
import vectorlib as v  # noqa: E402

SUITE = "aead-envelope"
VERSION = 1
ENVELOPE_TAG = "agentlink/envelope/v1"
OWNER_ACTION_TAG = "agentlink/owner-action/v1"
HEADER_FIELDS = ["v", "id", "thread", "from", "createdAt", "recipients"]
STRUCTURE = "04 §3.1 envelope v1 structure, §2.4.1 encodings, strict schema (M1-2a)"
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
        if set(a) != {"alg", "iv", "ct"} or a["alg"] != "A256GCM":
            return False
        b64u_len(a["iv"], 12)
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
    try:
        return v.aes256gcm_decrypt(cek, v.unb64u(envelope["aead"]["iv"]), v.unb64u(envelope["aead"]["ct"]), aad_of(envelope))
    except Exception:
        return None


def build():
    sender = v.det("aead-envelope/sender-agent/nostr", 32)
    other = v.det("aead-envelope/other-key/nostr", 32)
    cek = v.det("aead-envelope/cek", 32)
    iv = v.det("aead-envelope/iv", 12)
    aux = v.det("aead-envelope/aux-rand", 32)
    envelope_id = v.det("aead-envelope/id", 16)
    recipients = []
    for role in ["recipient-agent", "recipient-owner", "sender-owner", "sender-agent"]:
        public = v.x25519_public_key(v.det(f"aead-envelope/{role}/enc", 32))
        enc, wk = hpke.seal(public, v.det(f"aead-envelope/{role}/ephemeral", 32), hpke.CEK_INFO + envelope_id, b"", cek)
        recipients.append({"kid": v.b64u(v.sha256(public)[:16]), "enc": v.b64u(enc), "wk": v.b64u(wk)})
    plaintext = v.jcs({"type": "text", "body": "Hello from the AgentLink test vectors ✓", "replyTo": None, "files": []})

    env = {
        "v": 1,
        "id": v.b64u(envelope_id),
        "thread": v.b64u(v.det("aead-envelope/thread", 16)),
        "from": v.hx(v.xonly_public_key(sender)),
        "createdAt": 1760000000,
        "recipients": recipients,
    }
    ct = v.aes256gcm_encrypt(cek, iv, plaintext, aad_of(env))
    env["aead"] = {"alg": "A256GCM", "iv": v.b64u(iv), "ct": v.b64u(ct)}
    unsigned = copy.deepcopy(env)
    env["sig"] = v.hx(sign(env, sender, aux))
    if not verify(env) or decrypt(env, cek) != plaintext:
        v.fail("the reference envelope does not verify or decrypt")

    cases = [
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
            "04 §3.1 payload AEAD (AES-256-GCM, fixed IV)",
            {"op": "encryptPayload", "header": header(env), "cek": v.hx(cek), "iv": v.b64u(iv), "plaintext": v.hx(plaintext)},
            {"aad": v.hx(aad_of(env)), "ct": env["aead"]["ct"]},
        ),
        v.case(
            "decrypt-payload",
            "04 §3.1 payload AEAD open",
            {"op": "decryptPayload", "envelope": env, "cek": v.hx(cek)},
            {"plaintext": v.hx(plaintext)},
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
    ]
    for (m, why), name in zip(mutations, ["created-at", "recipients-reordered", "thread"]):
        cases.append(
            v.case(f"envelope-hash-{name}", f"04 §3.1 envelopeHash changes with {why}", {"op": "envelopeHash", "envelope": m}, {"envelopeHash": v.hx(envelope_hash(m))})
        )
        if decrypt(m, cek) is not None or verify(m):
            v.fail(f"{name}: still decrypts or verifies")
        cases.append(v.case(f"decrypt-reject-{name}", f"04 §3.1 AAD binds the header: {why}", {"op": "decryptPayload", "envelope": m, "cek": v.hx(cek)}, {"outcome": "reject"}))
        cases.append(v.case(f"verify-reject-{name}", f"04 §3.1 signature covers the header: {why}", {"op": "verify", "envelope": m}, {"outcome": "reject"}))

    def aead_variant(change):
        m = copy.deepcopy(env)
        change(m["aead"])
        return m

    ct_bytes = v.unb64u(env["aead"]["ct"])
    flipped_tag = aead_variant(lambda a: a.__setitem__("ct", v.b64u(hpke.flip(ct_bytes, len(ct_bytes) - 1))))
    flipped_ct = aead_variant(lambda a: a.__setitem__("ct", v.b64u(hpke.flip(ct_bytes, 0))))
    other_iv = aead_variant(lambda a: a.__setitem__("iv", v.b64u(v.det("aead-envelope/other-iv", 12))))
    for case_id, why, m, key in [
        ("decrypt-reject-tag-flipped", "tampered tag", flipped_tag, cek),
        ("decrypt-reject-ct-flipped", "tampered ciphertext", flipped_ct, cek),
        ("decrypt-reject-other-iv", "another IV", other_iv, cek),
        ("decrypt-reject-wrong-cek", "another CEK", env, v.det("aead-envelope/other-cek", 32)),
    ]:
        if decrypt(m, key) is not None:
            v.fail(f"{case_id} decrypts")
        cases.append(v.case(case_id, f"04 §3.1 payload AEAD: {why}", {"op": "decryptPayload", "envelope": m, "cek": v.hx(key)}, {"outcome": "reject"}))
    if verify(flipped_ct):
        v.fail("aead.ct is not covered by the signature")
    cases.append(v.case("verify-reject-ct-flipped", "04 §3.1 the signature covers aead.ct", {"op": "verify", "envelope": flipped_ct}, {"outcome": "reject"}))

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
        ("alg-a128gcm", "alg other than A256GCM", variant(set_path("aead", "alg", "A128GCM"))),
        ("iv-11-bytes", "iv of 11 bytes", variant(set_path("aead", "iv", v.b64u(v.unb64u(env["aead"]["iv"])[:11])))),
        ("iv-padded", "iv as padded base64url", variant(set_path("aead", "iv", env["aead"]["iv"] + "="))),
        ("ct-15-bytes", "ct shorter than the 16-byte tag", variant(set_path("aead", "ct", v.b64u(v.unb64u(env["aead"]["ct"])[:15])))),
        ("sig-uppercase", "sig in upper-case hex (the signature is otherwise valid)", variant(set_path("sig", env["sig"].upper()), resign=False)),
        ("sig-0x-prefix", "sig with 0x", variant(set_path("sig", "0x" + env["sig"]), resign=False)),
    ]:
        if validate(m):
            v.fail(f"validate-reject-{case_id} validates")
        cases.append(v.case(f"validate-reject-{case_id}", f"{STRUCTURE}: {why}; rejected, never normalised", {"op": "validate", "envelope": m}, {"outcome": "reject"}))
    return cases


SCHEMA = v.case_schema(
    SUITE,
    "04 §3.1 envelope. `envelopeHash`, `aad`: hashes of the given envelope. `encryptPayload`: AAD "
    "and base64url ct||tag for header, CEK, IV and plaintext. `decryptPayload`: plaintext or "
    "rejection. `sign`: envelopeHash, tagged signature input and sig. `verify`: accept or reject. "
    "`validate`: structure, encodings and signature together (strict).",
    {
        "envelopeHash": ({"envelope": v.OBJECT}, [{"envelopeHash": v.hexn(32)}]),
        "aad": ({"envelope": v.OBJECT}, [{"aad": v.hexn(32)}]),
        "encryptPayload": (
            {"header": v.OBJECT, "cek": v.hexn(32), "iv": v.B64U, "plaintext": v.HEX},
            [{"aad": v.hexn(32), "ct": v.B64U}],
        ),
        "decryptPayload": ({"envelope": v.OBJECT, "cek": v.hexn(32)}, [{"plaintext": v.HEX}, v.REJECT]),
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
