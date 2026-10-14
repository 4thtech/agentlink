#!/usr/bin/env python3
"""Independent generator for the `hpke` suite: RFC 9180 HPKE and the CEK wrap (M1-1h).

Suite: mode Base, KEM DHKEM(X25519, HKDF-SHA256) 0x0020, KDF HKDF-SHA256 0x0001, AEAD AES-256-GCM
0x0002 (04 §3.3). HPKE is `pyhpke` (on `cryptography`). The generator first reproduces the
official CFRG test vector for exactly this suite (cfrg/draft-irtf-cfrg-hpke test-vectors.json,
commit 5f503c564da00b0687b3de75f1dfbdfc4079ad31; full file SHA-256
61fc662f01996cd06d713dacf5e133167bd309a1f329442d53f1e21a47b3ede6; the values used are copied
below) and refuses to write on any difference.

AgentLink CEK wrap (04 §3.3): info = utf8("agentlink/v1/cek") || id (the envelope id as its raw 16
bytes), empty AAD, one single-shot seal of the 32-byte CEK per recipient. Ephemeral keys are fixed
test values so the output is deterministic (M1-1c's test seam). `enc` and `wk` are base64url
without padding, as in an envelope (04 §3.1). Negative cases: the wrong recipient key, another
envelope id, tampered or truncated `wk` and `enc`, the id encoded as text instead of raw bytes, a
non-empty AAD, and the all-zero X25519 shared secret RFC 9180 §7.1.4 requires to be rejected.

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
    "skEm": "179d4b53b6365c45b600c4163b61d95cbc2f4d9e36f1695558dce265ab8bab11",
    "pkEm": "6c93e09869df3402d7bf231bf540fadd35cd56be14f97178f0954db94b7fc256",
    "skRm": "497b4502664cfea5d5af0b39934dac72242a74f8480451e1aee7d6a53320333d",
    "pkRm": "430f4b9859665145a6b1ba274024487bd66f03a2dd577d7753c68d7d7d00c00c",
    "enc": "6c93e09869df3402d7bf231bf540fadd35cd56be14f97178f0954db94b7fc256",
    "pt": "4265617574792069732074727574682c20747275746820626561757479",
    "encryptions": [
        ("436f756e742d30", "e5d84cd531cfb583096e7cfa9641bd3079cf3a91cda813c52deb5f512be9931980a41de125a925cdad859d5b7a"),
        ("436f756e742d31", "2c43aff25343fdbff864506f0818b9d87df84ea01b1a2144d23b4d40c26bf655fdf197fe40297a8aebeed5cc2d"),
        ("436f756e742d32", "e0a8f2cf92ff61215edbb8c55dc31fe9e2eb42a5685867bb6854211542099f9e940c4b41c192bc390835b1a5f7"),
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


def flip(data, index):
    out = bytearray(data)
    out[index] ^= 0x01
    return bytes(out)


def build():
    v.check_x25519()
    o = OFFICIAL
    enc, ctx = sender(v.unhex(o["pkRm"]), v.unhex(o["skEm"]), v.unhex(o["info"]))
    if enc.hex() != o["enc"] or v.x25519_public_key(v.unhex(o["skRm"])).hex() != o["pkRm"]:
        v.fail("pyhpke disagrees with the CFRG vector (enc)")
    for aad, ct in o["encryptions"]:
        if ctx.seal(v.unhex(o["pt"]), v.unhex(aad)).hex() != ct:
            v.fail("pyhpke disagrees with the CFRG vector (ciphertext)")
    cases = [
        v.case(
            "rfc9180-base-seal-sequence",
            f"{RFC}: setup with skEm, encryptions 0-2 (published)",
            {
                "op": "sealSequence",
                "recipientPublicKey": o["pkRm"],
                "ephemeralSecretKey": o["skEm"],
                "info": o["info"],
                "messages": [{"aad": aad, "plaintext": o["pt"]} for aad, _ in o["encryptions"]],
            },
            {"enc": o["enc"], **{f"ciphertext{i}": ct for i, (_, ct) in enumerate(o["encryptions"])}},
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
        ("unwrap-reject-zero-shared-secret", "enc is the all-zero X25519 point (RFC 9180 §7.1.4)", secrets["recipient-agent"], envelope_id, bytes(32), wk),
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
            {"recipientPublicKey": v.hexn(32), "ephemeralSecretKey": v.hexn(32), "envelopeId": v.B64U, "cek": v.hexn(32)},
            [{"enc": v.B64U, "wk": v.B64U}],
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
