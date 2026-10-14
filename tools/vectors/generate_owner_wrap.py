#!/usr/bin/env python3
"""Independent generator for the `owner-wrap` suite: Argon2id for the passphrase path (M1-1h).

Argon2id v1.3 (RFC 9106) from `cryptography` (OpenSSL), checked first against the RFC 9106 §5.3
Argon2id test vector (with secret and associated data). The AgentLink cases run Argon2id at the
parameters the spec fixes: the owner passphrase wrap and recovery code, m = 64 MiB, t = 3, p = 1
(04 §2.3, §2.8, M1-1f), and the file KeyStore floor, m = 19 MiB, t = 2, p = 1 (04 §2.8), with
32-byte output, no secret and no associated data. Passwords follow 04 §2.8 password(): the UTF-8 bytes of an NFKC-normalised passphrase (kind 2)
or the 15 decoded bytes of a generated code (kind 1). Salts are synthetic test values.

These cases run in every runtime: Argon2id also protects the recovery code in the browser console
(04 §2.3). The ALKO blob, its kek and the cross-type cases are in the Node-only `keystore-file`
suite with ALKS (IR-M1-1h-1 Q7).

Usage: python3 -I tools/vectors/generate_owner_wrap.py --check [FILE] | --write
"""

import base64
import sys
import unicodedata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import vectorlib as v  # noqa: E402

SUITE = "owner-wrap"
VERSION = 1

RFC9106 = {
    "password": "01" * 32,
    "salt": "02" * 16,
    "secret": "03" * 8,
    "ad": "04" * 12,
    "memoryKiB": 32,
    "iterations": 3,
    "parallelism": 4,
    "length": 32,
    "tag": "0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659",
}


def build():
    r = RFC9106
    tag = v.argon2id(v.unhex(r["password"]), v.unhex(r["salt"]), r["memoryKiB"], r["iterations"], r["parallelism"], r["length"], v.unhex(r["secret"]), v.unhex(r["ad"]))
    if tag.hex() != r["tag"]:
        v.fail("Argon2id disagrees with RFC 9106 §5.3")
    cases = [
        v.case(
            "rfc9106-argon2id",
            "RFC 9106 §5.3 Argon2id test vector (published)",
            {"op": "argon2id", **{k: r[k] for k in ["password", "salt", "secret", "ad", "memoryKiB", "iterations", "parallelism", "length"]}},
            {"tag": r["tag"]},
        )
    ]
    code = base64.b32encode(v.det("owner-wrap/owner-code", 15)).decode("ascii")
    code_bytes = base64.b32decode(code)
    salt = v.det("owner-wrap/owner-code/salt", 16)
    cases.append(
        v.case(
            "owner-params-code",
            "Argon2id v1.3, owner wrap parameters; secretKind 1: the password is the 15 decoded code bytes (04 §2.8)",
            {"op": "argon2id", "password": v.hx(code_bytes), "salt": v.hx(salt), "secret": "", "ad": "", "memoryKiB": 65536, "iterations": 3, "parallelism": 1, "length": 32},
            {"tag": v.hx(v.argon2id(code_bytes, salt, 65536, 3, 1, 32))},
        )
    )
    for case_id, why, passphrase, m, t in [
        ("owner-params-ascii", "owner passphrase wrap parameters (m = 64 MiB, t = 3, p = 1)", "correct horse battery staple", 65536, 3),
        ("owner-params-unicode", "owner passphrase wrap parameters; NFKC-normalised UTF-8 password", "Ｐａｓｓ ﬁle Café ✓", 65536, 3),
        ("keystore-floor", "file KeyStore floor (m = 19 MiB, t = 2, p = 1)", "correct horse battery staple", 19456, 2),
    ]:
        password = unicodedata.normalize("NFKC", passphrase).encode("utf-8")
        salt = v.det(f"owner-wrap/{case_id}/salt", 16)
        cases.append(
            v.case(
                case_id,
                f"Argon2id v1.3, {why}",
                {"op": "argon2id", "password": v.hx(password), "salt": v.hx(salt), "secret": "", "ad": "", "memoryKiB": m, "iterations": t, "parallelism": 1, "length": 32},
                {"tag": v.hx(v.argon2id(password, salt, m, t, 1, 32))},
            )
        )
    return cases


SCHEMA = v.case_schema(
    SUITE,
    "Argon2id v1.3 (RFC 9106): password, salt, secret and associated data as hex (empty = none), "
    "memory in KiB, iterations, parallelism, output length; expected tag hex.",
    {
        "argon2id": (
            {
                "password": v.HEX,
                "salt": v.HEX,
                "secret": v.HEX,
                "ad": v.HEX,
                "memoryKiB": v.INTEGER,
                "iterations": v.INTEGER,
                "parallelism": v.INTEGER,
                "length": v.INTEGER,
            },
            [{"tag": v.HEX}],
        )
    },
)

if __name__ == "__main__":
    v.main(
        suite=SUITE,
        version=VERSION,
        script="tools/vectors/generate_owner_wrap.py",
        libraries=["cryptography"],
        build=build,
        schema=SCHEMA,
        doc=__doc__,
    )
