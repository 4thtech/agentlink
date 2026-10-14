#!/usr/bin/env python3
"""Independent generator for the `hpke` suite: RFC 9180 HPKE and the CEK wrap (M1-1h).

Suite: mode Base, KEM DHKEM(X25519, HKDF-SHA256) 0x0020, KDF HKDF-SHA256 0x0001, AEAD AES-256-GCM
0x0002 (04 §3.3). HPKE is `pyhpke` (on `cryptography`). The generator first reproduces the
official CFRG test vector for exactly this suite (cfrg/draft-irtf-cfrg-hpke test-vectors.json,
commit 5f503c564da00b0687b3de75f1dfbdfc4079ad31; full file SHA-256
61fc662f01996cd06d713dacf5e133167bd309a1f329442d53f1e21a47b3ede6; the public values used are
copied below, and the two published secret keys are read from the committed vectors.json, the only
place they are kept) and refuses to write on any difference.

AgentLink CEK wrap (04 §3.3): info = utf8("agentlink/v1/cek") || id (the envelope id as its raw 16
bytes), empty AAD, one single-shot seal of the 32-byte CEK per recipient. Ephemeral keys are fixed
test values so the output is deterministic (M1-1c's test seam). `enc` and `wk` are base64url
without padding, as in an envelope (04 §3.1). Negative cases: the wrong recipient key, another
envelope id, tampered or truncated `wk` and `enc`, the id encoded as text instead of raw bytes, a
non-empty AAD, envelope ids and CEKs of the wrong length, and every small-order X25519 point as
`enc` or as the recipient key. For the small-order `enc` cases, `wk` is sealed under the key
schedule of the all-zero DH output (written out below),
so only the RFC 9180 §7.1.4 all-zero check can reject them. The written-out schedule is checked
first: it must reproduce the published base nonce and ciphertexts 0-2.

Usage: python3 -I tools/vectors/generate_hpke.py --check [FILE] | --write
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import vectorlib as v  # noqa: E402

SUITE = "hpke"
VERSION = 1
CEK_INFO = b"agentlink/v1/cek"
RFC = "RFC 9180 / CFRG test-vectors.json (mode 0, kem 0x20, kdf 1, aead 2)"

# Published values (CFRG test-vectors.json, the entry for this suite).
OFFICIAL = {
    "info": "4f6465206f6e2061204772656369616e2055726e",
    "pkEm": "6c93e09869df3402d7bf231bf540fadd35cd56be14f97178f0954db94b7fc256",
    "pkRm": "430f4b9859665145a6b1ba274024487bd66f03a2dd577d7753c68d7d7d00c00c",
    "enc": "6c93e09869df3402d7bf231bf540fadd35cd56be14f97178f0954db94b7fc256",
    "pt": "4265617574792069732074727574682c20747275746820626561757479",
    "encryptions": [  # (aad, ct, nonce)
        ("436f756e742d30", "e5d84cd531cfb583096e7cfa9641bd3079cf3a91cda813c52deb5f512be9931980a41de125a925cdad859d5b7a", "151d9929e2449747889bc923"),
        ("436f756e742d31", "2c43aff25343fdbff864506f0818b9d87df84ea01b1a2144d23b4d40c26bf655fdf197fe40297a8aebeed5cc2d", "151d9929e2449747889bc922"),
        ("436f756e742d32", "e0a8f2cf92ff61215edbb8c55dc31fe9e2eb42a5685867bb6854211542099f9e940c4b41c192bc390835b1a5f7", "151d9929e2449747889bc921"),
    ],
}


def suite():
    from pyhpke import AEADId, CipherSuite, KDFId, KEMId

    return CipherSuite.new(KEMId.DHKEM_X25519_HKDF_SHA256, KDFId.HKDF_SHA256, AEADId.AES256_GCM)


def sender(recipient_public, ephemeral_secret, info):
    from pyhpke import KEMKeyPair

    s = suite()
    eph = KEMKeyPair(
        s.kem.deserialize_private_key(ephemeral_secret),
        s.kem.deserialize_public_key(v.x25519_public_key(ephemeral_secret)),
    )
    return s.create_sender_context(s.kem.deserialize_public_key(recipient_public), info, eks=eph)


def seal(recipient_public, ephemeral_secret, info, aad, plaintext):
    enc, ctx = sender(recipient_public, ephemeral_secret, info)
    return enc, ctx.seal(plaintext, aad)


def open_(recipient_secret, enc, info, aad, ciphertext):
    s = suite()
    try:
        ctx = s.create_recipient_context(enc, s.kem.deserialize_private_key(recipient_secret), info)
        return ctx.open(ciphertext, aad)
    except Exception:
        return None


# --- RFC 9180 key schedule written out (base mode), to build ciphertexts pyhpke refuses to make ----

KEM_SUITE = b"KEM" + (0x0020).to_bytes(2, "big")
HPKE_SUITE = b"HPKE" + (0x0020).to_bytes(2, "big") + (0x0001).to_bytes(2, "big") + (0x0002).to_bytes(2, "big")


def labeled_extract(suite_id, salt, label, ikm):
    return v.hmac_sha256(salt, b"HPKE-v1" + suite_id + label + ikm)


def labeled_expand(suite_id, prk, label, info, length):
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.kdf.hkdf import HKDFExpand

    labeled_info = length.to_bytes(2, "big") + b"HPKE-v1" + suite_id + label + info
    return HKDFExpand(algorithm=hashes.SHA256(), length=length, info=labeled_info).derive(prk)


def key_schedule(dh, enc, recipient_public, info):
    """DHKEM ExtractAndExpand and the base-mode KeySchedule (RFC 9180 §4.1, §5.1) from a given DH
    output. Returns (shared_secret, key, base_nonce)."""
    eae_prk = labeled_extract(KEM_SUITE, b"", b"eae_prk", dh)
    shared = labeled_expand(KEM_SUITE, eae_prk, b"shared_secret", enc + recipient_public, 32)
    psk_id_hash = labeled_extract(HPKE_SUITE, b"", b"psk_id_hash", b"")
    info_hash = labeled_extract(HPKE_SUITE, b"", b"info_hash", info)
    context = bytes(1) + psk_id_hash + info_hash
    secret = labeled_extract(HPKE_SUITE, shared, b"secret", b"")
    key = labeled_expand(HPKE_SUITE, secret, b"key", context, 32)
    return shared, key, labeled_expand(HPKE_SUITE, secret, b"base_nonce", context, 12)


# X25519 points of small order (RFC 7748 §5 and the usual blocklists) as 32-byte u-coordinates, and
# the same with bit 255 set (RFC 7748 masks it away). X25519 with any of them gives the all-zero
# output that RFC 9180 §7.1.4 requires the DH-KEM to reject.
_P = 2**255 - 19
SMALL_ORDER = [
    ("zero", (0).to_bytes(32, "little")),
    ("one", (1).to_bytes(32, "little")),
    ("order-8-a", bytes.fromhex("e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800")),
    ("order-8-b", bytes.fromhex("5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157")),
    ("p-minus-1", (_P - 1).to_bytes(32, "little")),
    ("p", _P.to_bytes(32, "little")),
    ("p-plus-1", (_P + 1).to_bytes(32, "little")),
]
SMALL_ORDER += [(f"{name}-high-bit", u[:31] + bytes([u[31] | 0x80])) for name, u in SMALL_ORDER]


def x25519(secret, u):
    from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey

    try:
        return X25519PrivateKey.from_private_bytes(secret).exchange(X25519PublicKey.from_public_bytes(u))
    except Exception:
        return None  # OpenSSL refuses an all-zero result


def raw_x25519_is_zero(secret, u):
    """RFC 7748 §5 X25519 written out (Montgomery ladder), only to confirm an all-zero output
    independently of OpenSSL's refusal."""
    k = bytearray(secret)
    k[0] &= 248
    k[31] &= 127
    k[31] |= 64
    scalar = int.from_bytes(k, "little")
    x1 = int.from_bytes(u, "little") & ((1 << 255) - 1)
    x2, z2, x3, z3, swap = 1, 0, x1, 1, 0
    for t in reversed(range(255)):
        bit = (scalar >> t) & 1
        swap ^= bit
        if swap:
            x2, x3, z2, z3 = x3, x2, z3, z2
        swap = bit
        a, b = (x2 + z2) % _P, (x2 - z2) % _P
        aa, bb = a * a % _P, b * b % _P
        e = (aa - bb) % _P
        c, d = (x3 + z3) % _P, (x3 - z3) % _P
        da, cb = d * a % _P, c * b % _P
        x3 = (da + cb) ** 2 % _P
        z3 = x1 * (da - cb) ** 2 % _P
        x2 = aa * bb % _P
        z2 = e * (aa + 121665 * e) % _P
    if swap:
        x2, z2 = x3, z3
    return x2 * pow(z2, _P - 2, _P) % _P == 0


def flip(data, index):
    out = bytearray(data)
    out[index] ^= 0x01
    return bytes(out)


def build():
    # The published secret keys skEm and skRm live only in the committed vectors.json (secret-scan
    # policy) and are read back from there; they must give the published pkEm/enc, pkRm, key
    # schedule and ciphertexts below, or nothing is written.
    committed = v.committed_inputs(SUITE)
    o = {
        **OFFICIAL,
        "skEm": committed["rfc9180-base-seal-sequence"]["ephemeralSecretKey"],
        "skRm": committed["rfc9180-base-open-0"]["recipientSecretKey"],
    }
    if v.x25519_public_key(v.unhex(o["skEm"])).hex() != o["pkEm"]:
        v.fail("skEm does not give the published pkEm")
    enc, ctx = sender(v.unhex(o["pkRm"]), v.unhex(o["skEm"]), v.unhex(o["info"]))
    if enc.hex() != o["enc"] or v.x25519_public_key(v.unhex(o["skRm"])).hex() != o["pkRm"]:
        v.fail("pyhpke disagrees with the CFRG vector (enc)")
    for aad, ct, _ in o["encryptions"]:
        if ctx.seal(v.unhex(o["pt"]), v.unhex(aad)).hex() != ct:
            v.fail("pyhpke disagrees with the CFRG vector (ciphertext)")
    # The written-out key schedule must reproduce the CFRG values before it is trusted below.
    dh = x25519(v.unhex(o["skEm"]), v.unhex(o["pkRm"]))
    shared, key, base_nonce = key_schedule(dh, v.unhex(o["enc"]), v.unhex(o["pkRm"]), v.unhex(o["info"]))
    # (Its intermediate secrets are not copied here; reproducing the published nonce and the
    # published ciphertexts 0-2 checks the schedule end to end.)
    if base_nonce.hex() != o["encryptions"][0][2] or not shared:
        v.fail("the written-out key schedule disagrees with the CFRG base nonce")
    for i, (aad, ct, nonce) in enumerate(o["encryptions"]):
        seq_nonce = (int.from_bytes(base_nonce, "big") ^ i).to_bytes(12, "big")
        if seq_nonce.hex() != nonce or v.aes256gcm_encrypt(key, seq_nonce, v.unhex(o["pt"]), v.unhex(aad)).hex() != ct:
            v.fail(f"the written-out key schedule does not reproduce ciphertext {i}")
    if raw_x25519_is_zero(v.unhex(o["skEm"]), v.unhex(o["pkRm"])):
        v.fail("the written-out X25519 calls a normal point small-order")
    cases = [
        v.case(
            "rfc9180-base-seal-sequence",
            f"{RFC}: setup with skEm, encryptions 0-2 (published)",
            {
                "op": "sealSequence",
                "recipientPublicKey": o["pkRm"],
                "ephemeralSecretKey": o["skEm"],
                "info": o["info"],
                "messages": [{"aad": aad, "plaintext": o["pt"]} for aad, _, _ in o["encryptions"]],
            },
            {"enc": o["enc"], **{f"ciphertext{i}": ct for i, (_, ct, _) in enumerate(o["encryptions"])}},
        ),
        v.case(
            "rfc9180-base-open-0",
            f"{RFC}: recipient opens encryption 0 (published)",
            {
                "op": "open",
                "recipientSecretKey": o["skRm"],
                "enc": o["enc"],
                "info": o["info"],
                "aad": o["encryptions"][0][0],
                "ciphertext": o["encryptions"][0][1],
            },
            {"plaintext": o["pt"]},
        ),
        v.case(
            "rfc9180-base-open-wrong-aad",
            f"{RFC}: encryption 0 opened with the AAD of encryption 1",
            {
                "op": "open",
                "recipientSecretKey": o["skRm"],
                "enc": o["enc"],
                "info": o["info"],
                "aad": o["encryptions"][1][0],
                "ciphertext": o["encryptions"][0][1],
            },
            {"outcome": "reject"},
        ),
    ]
    if open_(v.unhex(o["skRm"]), v.unhex(o["enc"]), v.unhex(o["info"]), v.unhex(o["encryptions"][1][0]), v.unhex(o["encryptions"][0][1])) is not None:
        v.fail("wrong AAD opened")

    # AgentLink CEK wrap. Recipient keys: X25519 secrets from synthetic test seeds (04 §3.2 roles).
    roles = ["recipient-agent", "recipient-owner", "sender-owner", "sender-agent"]
    secrets = {r: v.det(f"hpke/{r}/enc", 32) for r in roles}
    publics = {r: v.x25519_public_key(secrets[r]) for r in roles}
    envelope_id = v.det("hpke/envelope-id", 16)
    other_id = v.det("hpke/other-envelope-id", 16)
    cek = v.det("hpke/cek", 32)
    info = CEK_INFO + envelope_id

    wraps = {}
    for role in roles:
        eph = v.det(f"hpke/{role}/ephemeral", 32)
        enc, wk = seal(publics[role], eph, info, b"", cek)
        if open_(secrets[role], enc, info, b"", wk) != cek:
            v.fail("CEK wrap does not open")
        wraps[role] = (enc, wk)
        cases.append(
            v.case(
                f"wrap-cek-{role}",
                "04 §3.3 CEK wrap (fixed ephemeral key)",
                {
                    "op": "wrapCek",
                    "recipientPublicKey": v.hx(publics[role]),
                    "ephemeralSecretKey": v.hx(eph),
                    "envelopeId": v.b64u(envelope_id),
                    "cek": v.hx(cek),
                },
                {"enc": v.b64u(enc), "wk": v.b64u(wk)},
            )
        )
        cases.append(
            v.case(
                f"unwrap-cek-{role}",
                "04 §3.3 CEK unwrap",
                {"op": "unwrapCek", "recipientSecretKey": v.hx(secrets[role]), "envelopeId": v.b64u(envelope_id), "enc": v.b64u(enc), "wk": v.b64u(wk)},
                {"cek": v.hx(cek)},
            )
        )

    enc, wk = wraps["recipient-agent"]
    eph = v.det("hpke/recipient-agent/ephemeral", 32)
    text_id_enc, text_id_wk = seal(publics["recipient-agent"], eph, CEK_INFO + v.b64u(envelope_id).encode(), b"", cek)
    aad_enc, aad_wk = seal(publics["recipient-agent"], eph, info, envelope_id, cek)
    negatives = [
        ("unwrap-reject-wrong-recipient", "another recipient's key", secrets["recipient-owner"], envelope_id, enc, wk),
        ("unwrap-reject-other-envelope-id", "the CEK is bound to the envelope id through info", secrets["recipient-agent"], other_id, enc, wk),
        ("unwrap-reject-wk-tag-flipped", "tampered wk (last tag byte)", secrets["recipient-agent"], envelope_id, enc, flip(wk, len(wk) - 1)),
        ("unwrap-reject-wk-ciphertext-flipped", "tampered wk (first byte)", secrets["recipient-agent"], envelope_id, enc, flip(wk, 0)),
        ("unwrap-reject-wk-truncated", "wk one byte short", secrets["recipient-agent"], envelope_id, enc, wk[:-1]),
        ("unwrap-reject-enc-flipped", "tampered enc", secrets["recipient-agent"], envelope_id, flip(enc, 5), wk),
        ("unwrap-reject-id-as-text", "sealed with the id as base64url text in info, not its raw 16 bytes", secrets["recipient-agent"], envelope_id, text_id_enc, text_id_wk),
        ("unwrap-reject-nonempty-aad", "sealed with a non-empty AAD; the CEK wrap uses an empty AAD", secrets["recipient-agent"], envelope_id, aad_enc, aad_wk),
    ]
    for case_id, why, secret, env_id, bad_enc, bad_wk in negatives:
        if open_(secret, bad_enc, CEK_INFO + env_id, b"", bad_wk) is not None:
            v.fail(f"{case_id} opens")
        cases.append(
            v.case(
                case_id,
                f"04 §3.3 CEK unwrap fails: {why}",
                {"op": "unwrapCek", "recipientSecretKey": v.hx(secret), "envelopeId": v.b64u(env_id), "enc": v.b64u(bad_enc), "wk": v.b64u(bad_wk)},
                {"outcome": "reject"},
            )
        )

    # RFC 9180 §7.1.4: an all-zero DH output must be rejected. Each `wk` below is sealed under the
    # key schedule of that all-zero output, so it opens unless the explicit check refuses it.
    recipient_secret, recipient_public = secrets["recipient-agent"], publics["recipient-agent"]
    sender_eph = v.det("hpke/small-order/ephemeral", 32)
    for name, u in SMALL_ORDER:
        if not raw_x25519_is_zero(recipient_secret, u) or x25519(recipient_secret, u) is not None:
            v.fail(f"{name}: not an all-zero X25519 output")
        if not raw_x25519_is_zero(sender_eph, u) or x25519(sender_eph, u) is not None:
            v.fail(f"{name}: the sender's DH is not all zero")
        _, key, base_nonce = key_schedule(bytes(32), u, recipient_public, info)
        zero_wk = v.aes256gcm_encrypt(key, base_nonce, cek, b"")
        if open_(recipient_secret, u, info, b"", zero_wk) is not None:
            v.fail(f"{name}: pyhpke opens a zero-DH wk")
        cases.append(
            v.case(
                f"unwrap-reject-small-order-enc-{name}",
                "RFC 9180 §7.1.4: enc is a small-order X25519 point, so the DH output is all zero; wk is "
                "sealed under the all-zero key schedule and opens unless the all-zero check rejects it",
                {"op": "unwrapCek", "recipientSecretKey": v.hx(recipient_secret), "envelopeId": v.b64u(envelope_id), "enc": v.b64u(u), "wk": v.b64u(zero_wk)},
                {"outcome": "reject"},
            )
        )
        cases.append(
            v.case(
                f"wrap-reject-small-order-recipient-{name}",
                "RFC 9180 §7.1.4: the recipient key is a small-order X25519 point, so the sender's DH output is all zero",
                {"op": "wrapCek", "recipientPublicKey": v.hx(u), "ephemeralSecretKey": v.hx(sender_eph), "envelopeId": v.b64u(envelope_id), "cek": v.hx(cek)},
                {"outcome": "reject"},
            )
        )

    # Lengths fixed by 04 §3.1 and §3.3: the envelope id is 16 bytes and the CEK 32 bytes.
    eph = v.det("hpke/recipient-agent/ephemeral", 32)
    for case_id, why, env_id, the_cek in [
        ("wrap-reject-id-15-bytes", "an envelope id of 15 bytes", envelope_id[:15], cek),
        ("wrap-reject-id-17-bytes", "an envelope id of 17 bytes", envelope_id + bytes(1), cek),
        ("wrap-reject-cek-31-bytes", "a CEK of 31 bytes", envelope_id, cek[:31]),
        ("wrap-reject-cek-33-bytes", "a CEK of 33 bytes", envelope_id, cek + bytes(1)),
    ]:
        cases.append(
            v.case(
                case_id,
                f"04 §3.1, §3.3: {why}",
                {"op": "wrapCek", "recipientPublicKey": v.hx(recipient_public), "ephemeralSecretKey": v.hx(eph), "envelopeId": v.b64u(env_id), "cek": v.hx(the_cek)},
                {"outcome": "reject"},
            )
        )
    short_id = envelope_id[:15]
    short_id_enc, short_id_wk = seal(recipient_public, eph, CEK_INFO + short_id, b"", cek)
    short_cek_enc, short_cek_wk = seal(recipient_public, eph, info, b"", cek[:31])
    for case_id, why, env_id, the_enc, the_wk in [
        ("unwrap-reject-id-15-bytes", "an envelope id of 15 bytes (wk sealed with that id)", short_id, short_id_enc, short_id_wk),
        ("unwrap-reject-cek-31-bytes", "wk opens to a 31-byte CEK", envelope_id, short_cek_enc, short_cek_wk),
    ]:
        if open_(recipient_secret, the_enc, CEK_INFO + env_id, b"", the_wk) is None:
            v.fail(f"{case_id}: should open as HPKE")
        cases.append(
            v.case(
                case_id,
                f"04 §3.1, §3.3: {why}; HPKE itself succeeds, so only the length check refuses it",
                {"op": "unwrapCek", "recipientSecretKey": v.hx(recipient_secret), "envelopeId": v.b64u(env_id), "enc": v.b64u(the_enc), "wk": v.b64u(the_wk)},
                {"outcome": "reject"},
            )
        )
    return cases


MESSAGE = {
    "type": "object",
    "additionalProperties": False,
    "required": ["aad", "plaintext"],
    "properties": {"aad": v.HEX, "plaintext": v.HEX},
}
SCHEMA = v.case_schema(
    SUITE,
    "RFC 9180 HPKE, mode Base, X25519/HKDF-SHA256/AES-256-GCM. `sealSequence`: one sender context "
    "with a fixed ephemeral key, messages sealed in order. `open`: single-shot open. `wrapCek` / "
    "`unwrapCek`: 04 §3.3 CEK wrap, info = utf8(\"agentlink/v1/cek\") || raw 16-byte id, empty AAD; "
    "enc and wk base64url without padding.",
    {
        "sealSequence": (
            {"recipientPublicKey": v.hexn(32), "ephemeralSecretKey": v.hexn(32), "info": v.HEX, "messages": {"type": "array", "items": MESSAGE}},
            [{"enc": v.hexn(32), "ciphertext0": v.HEX, "ciphertext1": v.HEX, "ciphertext2": v.HEX}],
        ),
        "open": (
            {"recipientSecretKey": v.hexn(32), "enc": v.hexn(32), "info": v.HEX, "aad": v.HEX, "ciphertext": v.HEX},
            [{"plaintext": v.HEX}, v.REJECT],
        ),
        "wrapCek": (
            {"recipientPublicKey": v.hexn(32), "ephemeralSecretKey": v.hexn(32), "envelopeId": v.B64U, "cek": v.HEX},
            [{"enc": v.B64U, "wk": v.B64U}, v.REJECT],
        ),
        "unwrapCek": (
            {"recipientSecretKey": v.hexn(32), "envelopeId": v.B64U, "enc": v.B64U, "wk": v.B64U},
            [{"cek": v.hexn(32)}, v.REJECT],
        ),
    },
)

if __name__ == "__main__":
    v.main(
        suite=SUITE,
        version=VERSION,
        script="tools/vectors/generate_hpke.py",
        libraries=["cryptography", "pyhpke"],
        build=build,
        schema=SCHEMA,
        doc=__doc__,
    )
