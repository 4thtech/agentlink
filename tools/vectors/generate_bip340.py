#!/usr/bin/env python3
"""Independent generator for the `bip340` suite: BIP-340 Schnorr signatures (M1-1h).

Every case is from the official BIP-340 test vectors (bitcoin/bips, bip-0340/test-vectors.csv,
commit 200f9b26fe0a2f235a2af8b30c4be9f12f6bc9cb, SHA-256 below), committed under
tools/vectors/sources/. Cases with a 32-byte message are recomputed with libsecp256k1 (coincurve):
signatures must be byte-identical and every verification result must agree with the published
one, or nothing is written. coincurve only signs 32-byte messages, so the four variable-length
cases (15-18) are taken as published. AgentLink's own uses of BIP-340 (envelope and owner-action
signatures over tagged hashes) are in the `aead-envelope` and `owner-action` suites.

Usage: python3 -I tools/vectors/generate_bip340.py --check [FILE] | --write
"""

import csv
import io
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import vectorlib as v  # noqa: E402

SUITE = "bip340"
VERSION = 1
SOURCE_FILE = "bip340-test-vectors.csv"
SOURCE_SHA256 = "34c9d1d9c3a88d524bc80778540dc43f8306ec249a7485293063c376db851c2d"
SOURCE = "BIP-340 test-vectors.csv (bitcoin/bips@200f9b26)"


def build():
    rows = list(csv.DictReader(io.StringIO(v.read_source(SOURCE_FILE, SOURCE_SHA256).decode("ascii"))))
    if len(rows) != 19:
        v.fail("expected 19 BIP-340 vectors")
    sign_cases, verify_cases = [], []
    for row in rows:
        index = int(row["index"])
        secret = row["secret key"].lower()
        public = row["public key"].lower()
        aux = row["aux_rand"].lower()
        message = row["message"].lower()
        signature = row["signature"].lower()
        accepted = row["verification result"] == "TRUE"
        comment = row["comment"].strip()
        note = f" ({comment})" if comment else ""
        recomputed = len(message) == 64
        if recomputed:
            if v.schnorr_verify(bytes.fromhex(public), bytes.fromhex(message), bytes.fromhex(signature)) != accepted:
                v.fail(f"libsecp256k1 disagrees with BIP-340 vector {index}")
        if secret:
            if recomputed:
                if v.xonly_public_key(bytes.fromhex(secret)).hex() != public:
                    v.fail(f"public key of BIP-340 vector {index} differs")
                if v.schnorr_sign(bytes.fromhex(secret), bytes.fromhex(message), bytes.fromhex(aux)).hex() != signature:
                    v.fail(f"signature of BIP-340 vector {index} differs")
            how = "recomputed with libsecp256k1" if recomputed else "published value (variable-length message)"
            sign_cases.append(
                v.case(
                    f"sign-{index}",
                    f"{SOURCE}, index {index}{note}; {how}",
                    {"op": "sign", "secretKey": secret, "auxRand": aux, "message": message},
                    {"publicKey": public, "signature": signature},
                )
            )
        how = "agrees with libsecp256k1" if recomputed else "published value (variable-length message)"
        verify_cases.append(
            v.case(
                f"verify-{index}",
                f"{SOURCE}, index {index}{note}; {how}",
                {"op": "verify", "publicKey": public, "message": message, "signature": signature},
                {"outcome": "accept" if accepted else "reject"},
            )
        )
    return sign_cases + verify_cases


SCHEMA = v.case_schema(
    SUITE,
    "BIP-340. `sign`: secret key, aux_rand and message (hex) to the x-only public key and the "
    "64-byte signature. `verify`: public key, message and signature (hex) to accept or reject; "
    "public keys that are not on the curve or not below the field size are rejected.",
    {
        "sign": (
            {"secretKey": v.hexn(32), "auxRand": v.hexn(32), "message": v.HEX},
            [{"publicKey": v.hexn(32), "signature": v.hexn(64)}],
        ),
        "verify": (
            {"publicKey": v.hexn(32), "message": v.HEX, "signature": v.hexn(64)},
            [v.ACCEPT, v.REJECT],
        ),
    },
)

if __name__ == "__main__":
    v.main(
        suite=SUITE,
        version=VERSION,
        script="tools/vectors/generate_bip340.py",
        libraries=["coincurve"],
        build=build,
        schema=SCHEMA,
        doc=__doc__,
    )
