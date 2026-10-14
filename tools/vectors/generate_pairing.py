#!/usr/bin/env python3
"""Independent generator for the `pairing` suite: HMAC-SHA256 for the pairing proof (M1-1h).

04 §3.6: proof = HMAC-SHA256(secret, utf8("agentlink-handshake") || inviteId || sha256(JCS(B card))).
This file holds the RFC 4231 HMAC-SHA256 test cases 1-4, 6 and 7 (case 5 is a truncated output),
recomputed with CPython's hmac/hashlib. The AgentLink construction itself is not yet included:
the byte form of `inviteId` inside the HMAC input (raw 16 bytes or its base64url text) and the
JSON form of the AgentCard that JCS is applied to are not fixed by the spec (questions in the
M1-1h PR). The safety code waits for G-28.

Usage: python3 -I tools/vectors/generate_pairing.py --check [FILE] | --write
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import vectorlib as v  # noqa: E402

SUITE = "pairing"
VERSION = 1

# RFC 4231 section 4: (case, key hex, data hex, published HMAC-SHA-256).
RFC4231 = [
    (1, "0b" * 20, b"Hi There".hex(), "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"),
    (2, b"Jefe".hex(), b"what do ya want for nothing?".hex(), "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"),
    (3, "aa" * 20, "dd" * 50, "773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe"),
    (4, bytes(range(1, 26)).hex(), "cd" * 50, "82558a389a443c0ea4cc819899f2083a85f0faa3e578f8077a2e3ff46729665b"),
    (6, "aa" * 131, b"Test Using Larger Than Block-Size Key - Hash Key First".hex(), "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"),
    (
        7,
        "aa" * 131,
        b"This is a test using a larger than block-size key and a larger than block-size data. "
        b"The key needs to be hashed before being used by the HMAC algorithm.".hex(),
        "9b09ffa71b942fcb27635fbcd5b0e944bfdc63644f0713938a7f51535c3a35e2",
    ),
]


def build():
    cases = []
    for number, key, data, published in RFC4231:
        if v.hmac_sha256(v.unhex(key), v.unhex(data)).hex() != published:
            v.fail(f"HMAC-SHA256 disagrees with RFC 4231 test case {number}")
        cases.append(
            v.case(
                f"rfc4231-{number}",
                f"RFC 4231 §4 test case {number}, HMAC-SHA-256 (published)",
                {"op": "hmacSha256", "key": key, "data": data},
                {"mac": published},
            )
        )
    return cases


SCHEMA = v.case_schema(
    SUITE,
    "HMAC-SHA256 (the pairing proof primitive, 04 §3.6): key and data hex to the 32-byte MAC.",
    {"hmacSha256": ({"key": v.HEX, "data": v.HEX}, [{"mac": v.hexn(32)}])},
)

if __name__ == "__main__":
    v.main(
        suite=SUITE,
        version=VERSION,
        script="tools/vectors/generate_pairing.py",
        libraries=[],
        build=build,
        schema=SCHEMA,
        doc=__doc__,
    )
