#!/usr/bin/env python3
"""Independent generator for the `prf-wrap` suite: the passkey PRF wrap key (M1-1i).

04 §2.3 step 3: the console asks the passkey's PRF extension for one output under the PRF salt
sha256("agentlink-owner-v1") (32 bytes, the value the client passes as the PRF `eval.first` input),
and derives wrapKey = HKDF-SHA256(ikm = PRF output, salt = "" (empty), info = "owner-seed-wrap",
L = 32). HKDF comes from `cryptography` (OpenSSL) and is cross-checked, before anything is written,
against RFC 5869 test case 3 (empty salt and info) and, for every case, against RFC 5869 written out
over hashlib HMAC (vectorlib.hkdf_sha256_written_out).

The PRF outputs are synthetic test values (vectorlib.det), plus all-zero and all-0xff edge values.
A real PRF output comes from the authenticator and never leaves the browser (04 §2.3). The sealed
seed blob (AES-256-GCM under wrapKey) has no vectors yet: 04 §2.3 does not fix its nonce, AAD or
layout (M1-1k; 04 §2.8 says only that it is not `ALKO`). A PRF output of another length is not
specified either (WebAuthn PRF outputs are 32 bytes), so there are no length rejections.

Usage: python3 -I tools/vectors/generate_prf_wrap.py --check [FILE] | --write
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import vectorlib as v  # noqa: E402

SUITE = "prf-wrap"
VERSION = 1

PRF_SALT_LABEL = b"agentlink-owner-v1"
WRAP_INFO = b"owner-seed-wrap"

RFC5869_TC3 = {
    "ikm": "0b" * 22,
    "length": 42,
    "okm": "8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8",
}

SPEC = "04 §2.3 step 3"


def wrap_key(prf_output):
    key = v.hkdf_sha256(prf_output, b"", WRAP_INFO, 32)
    if key != v.hkdf_sha256_written_out(prf_output, b"", WRAP_INFO, 32):
        v.fail("cryptography HKDF and the written-out RFC 5869 HKDF differ")
    return key


def build():
    tc3 = v.hkdf_sha256(bytes.fromhex(RFC5869_TC3["ikm"]), b"", b"", RFC5869_TC3["length"])
    if tc3.hex() != RFC5869_TC3["okm"]:
        v.fail("HKDF does not reproduce RFC 5869 test case 3")
    if v.hkdf_sha256_written_out(bytes.fromhex(RFC5869_TC3["ikm"]), b"", b"", 42).hex() != RFC5869_TC3["okm"]:
        v.fail("the written-out HKDF does not reproduce RFC 5869 test case 3")

    cases = [
        v.case(
            "prf-salt",
            f"{SPEC}: the PRF salt is sha256(utf8(\"agentlink-owner-v1\")), 32 bytes",
            {"op": "prfSalt"},
            {"salt": v.sha256(PRF_SALT_LABEL).hex()},
        )
    ]
    outputs = [
        ("wrap-key-1", "a synthetic PRF output", v.det("prf-wrap/output/1", 32)),
        ("wrap-key-2", "another synthetic PRF output (a different wrapKey)", v.det("prf-wrap/output/2", 32)),
        ("wrap-key-zero", "an all-zero PRF output", bytes(32)),
        ("wrap-key-ff", "an all-0xff PRF output", b"\xff" * 32),
    ]
    keys = set()
    for case_id, why, output in outputs:
        key = wrap_key(output)
        keys.add(key)
        cases.append(
            v.case(
                case_id,
                f"{SPEC}: wrapKey = HKDF-SHA256(ikm = PRF output, salt = \"\", info = \"owner-seed-wrap\", L = 32); {why}",
                {"op": "wrapKey", "prfOutput": output.hex()},
                {"wrapKey": key.hex()},
            )
        )
    if len(keys) != len(outputs):
        v.fail("two PRF outputs give the same wrapKey")
    return cases


SCHEMA = v.case_schema(
    SUITE,
    "Passkey PRF wrap key (04 §2.3). `prfSalt`: the 32-byte PRF salt sha256(\"agentlink-owner-v1\"). "
    "`wrapKey`: HKDF-SHA256 of a 32-byte PRF output with an empty salt and info \"owner-seed-wrap\", "
    "32 bytes. Hex without 0x.",
    {
        "prfSalt": ({}, [{"salt": v.hexn(32)}]),
        "wrapKey": ({"prfOutput": v.hexn(32)}, [{"wrapKey": v.hexn(32)}]),
    },
)

if __name__ == "__main__":
    v.main(
        suite=SUITE,
        version=VERSION,
        script="tools/vectors/generate_prf_wrap.py",
        libraries=["cryptography"],
        build=build,
        schema=SCHEMA,
        doc=__doc__,
    )
