#!/usr/bin/env python3
"""Independent generator for the `hkdf-derive` suite: key derivation and public identities (M1-1h).

04 §2.1, exactly:
  okm = HKDF-SHA256(ikm = masterSeed, salt = utf8("agentlink-v1"),
                    info = utf8(label) || 0x00 || u32be(epoch) || u8(counter), L = 32)
HKDF is `cryptography`'s (OpenSSL), checked first against RFC 5869 test cases 1-3. secp256k1
public keys come from libsecp256k1 (coincurve), EVM addresses from Keccak-256 (pycryptodome) with
EIP-55 checksums checked against the published EIP-55 examples, X25519 public keys from
`cryptography` (checked against the CFRG HPKE key pairs in the `hpke` suite). `kid` = first 16 bytes of SHA-256(encPub)
(04 §3.1), base64url without padding as it appears in an envelope.

Ops:
  hkdf    the bare RFC 5869 function (published values).
  derive  the 04 §2.1 formula for an explicit counter: labels x epochs 0-2 (the EVM key only at
          epoch 0), counter 1, u32 epoch boundaries; seeds that are not 32 bytes and epoch or
          counter values that do not fit u32/u8 are rejected.
  key     the public identity for (label, epoch): secp256k1 labels run the rejection loop from
          counter 0 (it never triggers for these seeds; a natural vector is infeasible, M1-1b uses
          an injected okm); `agentlink/v1/evm` at an epoch other than 0 is rejected (M1-1b).
The seeds are synthetic test values, never real keys.

Usage: python3 -I tools/vectors/generate_hkdf_derive.py --check [FILE] | --write
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import vectorlib as v  # noqa: E402

SUITE = "hkdf-derive"
VERSION = 1
SALT = b"agentlink-v1"
EVM, NOSTR, ENC, DROP = "agentlink/v1/evm", "agentlink/v1/nostr", "agentlink/v1/enc", "agentlink/v1/drop"
LABELS = [("evm", EVM), ("nostr", NOSTR), ("enc", ENC), ("drop", DROP)]
SEEDS = [
    ("a", bytes(range(32))),
    ("b", v.det("hkdf-derive/seed-b", 32)),
    ("c", b"\xff" * 32),
]

RFC5869 = [
    (
        "rfc5869-1",
        "RFC 5869 Appendix A.1 (published)",
        "0b" * 22,
        "000102030405060708090a0b0c",
        "f0f1f2f3f4f5f6f7f8f9",
        42,
        "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865",
    ),
    (
        "rfc5869-2",
        "RFC 5869 Appendix A.2 (published)",
        bytes(range(0x00, 0x50)).hex(),
        bytes(range(0x60, 0xB0)).hex(),
        bytes(range(0xB0, 0x100)).hex(),
        82,
        "b11e398dc80327a1c8e7f78c596a49344f012eda2d4efad8a050cc4c19afa97c59045a99cac7827271cb41c6"
        "5e590e09da3275600c2f09b8367793a9aca3db71cc30c58179ec3e87c14c01d5c1f3434f1d87",
    ),
    (
        "rfc5869-3",
        "RFC 5869 Appendix A.3 (published)",
        "0b" * 22,
        "",
        "",
        42,
        "8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8",
    ),
]


def info(label, epoch, counter):
    return label.encode("utf-8") + b"\x00" + v.u32be(epoch) + v.u8(counter)


def derive(seed, label, epoch, counter):
    return v.hkdf_sha256(seed, SALT, info(label, epoch, counter), 32)


def secp_secret(seed, label, epoch):
    for counter in range(256):
        okm = derive(seed, label, epoch, counter)
        if 0 < int.from_bytes(okm, "big") < v.SECP256K1_N:
            if counter != 0:
                v.fail("the rejection loop triggered; pick another test seed")
            return okm
    v.fail("no valid secp256k1 key")


def build():
    v.check_eip55()
    cases = []
    for case_id, source, ikm, salt, info_hex, length, published in RFC5869:
        okm = v.hkdf_sha256(v.unhex(ikm), v.unhex(salt), v.unhex(info_hex), length)
        if okm.hex() != published:
            v.fail(f"HKDF disagrees with {case_id}")
        cases.append(
            v.case(case_id, source, {"op": "hkdf", "ikm": ikm, "salt": salt, "info": info_hex, "length": length}, {"okm": published})
        )

    def derive_case(case_id, source, seed, label, epoch, counter):
        cases.append(
            v.case(
                case_id,
                source,
                {"op": "derive", "masterSeed": v.hx(seed), "label": label, "epoch": epoch, "counter": counter},
                {"okm": v.hx(derive(seed, label, epoch, counter))},
            )
        )

    for seed_id, seed in SEEDS:
        for label_id, label in LABELS:
            for epoch in [0] if label == EVM else [0, 1, 2]:
                derive_case(f"derive-{label_id}-e{epoch}-seed-{seed_id}", "04 §2.1", seed, label, epoch, 0)
    seed_a = SEEDS[0][1]
    for label_id, label in LABELS:
        derive_case(f"derive-{label_id}-counter-1", "04 §2.1 (u8 counter = 1, as after one rejection)", seed_a, label, 0, 1)
    derive_case("derive-nostr-epoch-256", "04 §2.1 (u32be epoch byte order)", seed_a, NOSTR, 256, 0)
    derive_case("derive-nostr-epoch-max", "04 §2.1 (largest u32 epoch)", seed_a, NOSTR, 2**32 - 1, 0)
    derive_case("derive-enc-counter-255", "04 §2.1 (largest u8 counter)", seed_a, ENC, 0, 255)

    for case_id, why, seed, epoch, counter in [
        ("derive-reject-epoch-2-pow-32", "epoch does not fit u32be", seed_a, 2**32, 0),
        ("derive-reject-epoch-negative", "epoch does not fit u32be", seed_a, -1, 0),
        ("derive-reject-counter-256", "counter does not fit u8", seed_a, 0, 256),
        ("derive-reject-counter-negative", "counter does not fit u8", seed_a, 0, -1),
        ("derive-reject-seed-31-bytes", "the master seed is 32 bytes (04 §2)", seed_a[:31], 0, 0),
        ("derive-reject-seed-33-bytes", "the master seed is 32 bytes (04 §2)", seed_a + b"\x00", 0, 0),
    ]:
        cases.append(
            v.case(
                case_id,
                f"04 §2.1: {why}",
                {"op": "derive", "masterSeed": v.hx(seed), "label": NOSTR, "epoch": epoch, "counter": counter},
                {"outcome": "reject"},
            )
        )

    for seed_id, seed in SEEDS[:2]:
        for label_id, label in LABELS:
            for epoch in [0] if label == EVM else [0, 1, 2]:
                if label == ENC:
                    public = v.x25519_public_key(derive(seed, label, epoch, 0))
                    expected = {"publicKey": v.hx(public), "kid": v.b64u(v.sha256(public)[:16])}
                    source = "04 §2.1 X25519 (RFC 7748 clamping by the library), §3.1 kid"
                elif label == EVM:
                    address = v.evm_address(secp_secret(seed, label, epoch))
                    expected = {"address": address, "addressChecksummed": v.eip55(address)}
                    source = (
                        "04 §2.1 secp256k1 EVM address: canonical 0x + lowercase hex (04 §2.4.1) "
                        "and its EIP-55 display form"
                    )
                else:
                    expected = {"publicKey": v.hx(v.xonly_public_key(secp_secret(seed, label, epoch)))}
                    source = "04 §2.1 secp256k1, BIP-340 x-only public key"
                cases.append(
                    v.case(
                        f"key-{label_id}-e{epoch}-seed-{seed_id}",
                        source,
                        {"op": "key", "masterSeed": v.hx(seed), "label": label, "epoch": epoch},
                        expected,
                    )
                )
    for epoch in (1, 2):
        cases.append(
            v.case(
                f"key-reject-evm-e{epoch}",
                "04 §2.1: agentlink/v1/evm is always epoch 0 (M1-1b: the API rejects other epochs)",
                {"op": "key", "masterSeed": v.hx(seed_a), "label": EVM, "epoch": epoch},
                {"outcome": "reject"},
            )
        )
    for case_id, label in [("key-reject-unknown-label", "agentlink/v1/unknown"), ("key-reject-label-v2", "agentlink/v2/nostr")]:
        cases.append(
            v.case(
                case_id,
                "04 §2.1: only the four labels of the table derive keys",
                {"op": "key", "masterSeed": v.hx(seed_a), "label": label, "epoch": 0},
                {"outcome": "reject"},
            )
        )
    return cases


LABEL = {"enum": [EVM, NOSTR, ENC, DROP]}
SCHEMA = v.case_schema(
    SUITE,
    "04 §2.1 key derivation. `hkdf`: RFC 5869 HKDF-SHA256. `derive`: okm for (masterSeed, label, "
    "epoch, counter), or a rejection. `key`: the public identity for (label, epoch): EIP-55 "
    "address and its EIP-55 display form (evm), x-only public key (nostr, drop), X25519 public key and kid (enc), or a "
    "rejection.",
    {
        "hkdf": (
            {"ikm": v.HEX, "salt": v.HEX, "info": v.HEX, "length": v.INTEGER},
            [{"okm": v.HEX}],
        ),
        "derive": (
            {"masterSeed": v.HEX, "label": LABEL, "epoch": v.INTEGER, "counter": v.INTEGER},
            [{"okm": v.hexn(32)}, v.REJECT],
        ),
        "key": (
            {"masterSeed": v.hexn(32), "label": v.STRING, "epoch": v.INTEGER},
            [
                {"address": v.ADDRESS, "addressChecksummed": v.CHECKSUM_ADDRESS},
                {"publicKey": v.hexn(32)},
                {"publicKey": v.hexn(32), "kid": v.B64U},
                v.REJECT,
            ],
        ),
    },
)

if __name__ == "__main__":
    v.main(
        suite=SUITE,
        version=VERSION,
        script="tools/vectors/generate_hkdf_derive.py",
        libraries=["cryptography", "coincurve", "pycryptodome"],
        build=build,
        schema=SCHEMA,
        doc=__doc__,
    )
