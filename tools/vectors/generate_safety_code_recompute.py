#!/usr/bin/env python3
"""Independent generator for the `safety-code-recompute` suite: 04 §3.6.1 steps 1-5 (M1-1h; G-28).

A full signed handshake H and handshake-ack K recomputed per 04 §3.6.1 steps 1-5 from the surface's
own agent ID, the contact's current card and H and K as envelopes with their CEKs, plus one failing
pair per step 1-4. The cases are built by generate_safety_code.py (same keys, cards, nonces and
envelopes) and split into their own suite because they need the envelope helpers of M1-1c, while
`safety-code` needs only M1-1f (IR-M1-1f-1 M-1). Keys and nonces are synthetic.

Version 2 (M1-1l; G-46, D-66): H and K are on the key-committing envelope form of 04 §3.1 and §3.3
(`aead` with `alg` "A256GCM-KC" and `kc`, the payload under encKey, the wraps' ephemeral keys
derived from the CEK), and opening them checks `kc` first. The cases are otherwise unchanged.

Version 3 (M1-2d; G-24, D-65; G-23, G-28): K carries `relays`, the inviter's list exactly as in the
invite, and every relay list carried with a card has 2 to 16 entries, so H and K use cards over
2-relay lists. Each opened body is parsed by the strict pairing-body schema (`pairing-bodies`
reference parser) before steps 1-5. New rejections: K without `relays`, with 1 or 17 relays or with
an extra `name`; H with 1 relay; and H with a tampered `codeCommit` (step 3).

Usage: python3 -I tools/vectors/generate_safety_code_recompute.py --check [FILE] | --write
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import generate_safety_code as safety  # noqa: E402
import vectorlib as v  # noqa: E402

SUITE = "safety-code-recompute"
VERSION = 3

SCHEMA = v.case_schema(
    SUITE,
    "04 §3.6.1 steps 1-5. `recompute`: pairingDigest and the shown code from the surface's own agent "
    "ID, the contact's current card and the signed H and K (with their CEKs), or a rejection.",
    {"recompute": safety.RECOMPUTE_SCHEMA_OP},
)

if __name__ == "__main__":
    v.main(
        suite=SUITE,
        version=VERSION,
        script="tools/vectors/generate_safety_code_recompute.py",
        libraries=["cryptography", "coincurve", "pycryptodome", "pyhpke", "rfc8785"],
        build=safety.build_recompute,
        schema=SCHEMA,
        doc=__doc__,
    )
