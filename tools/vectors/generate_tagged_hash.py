#!/usr/bin/env python3
"""Independent generator for the `tagged-hash` suite: BIP-340 tagged hashes (M1-1h).

taggedHash(tag, msg) = SHA256(SHA256(tag) || SHA256(tag) || msg) (BIP-340, "Design"), computed
with CPython's hashlib. The tags are BIP-340's own and AgentLink's domain-separation tags:
`agentlink/envelope/v1` (04 §3.1) and `agentlink/owner-action/v1` (04 §2.5.1). The cases show that
the same message gives unrelated digests under different tags, which is what keeps an envelope
signature from ever being a valid owner-action or Nostr event signature, and the reverse.

Usage: python3 -I tools/vectors/generate_tagged_hash.py --check [FILE] | --write
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import vectorlib as v  # noqa: E402

SUITE = "tagged-hash"
VERSION = 1

TAGS = [
    ("envelope", "agentlink/envelope/v1", "04 §3.1 envelope signature tag"),
    ("owner-action", "agentlink/owner-action/v1", "04 §2.5.1 owner-action signature tag"),
    ("bip340-challenge", "BIP0340/challenge", "BIP-340 challenge tag"),
    ("bip340-aux", "BIP0340/aux", "BIP-340 aux tag"),
]
MESSAGES = [
    ("empty", b""),
    ("zero32", bytes(32)),
    ("hash32", v.sha256(b"abc")),
    ("bytes33", bytes(range(33))),
]


def build():
    cases = []
    distinct = set()
    for tag_id, tag, why in TAGS:
        for message_id, message in MESSAGES:
            digest = v.tagged_hash(tag, message)
            distinct.add(digest)
            cases.append(
                v.case(
                    f"{tag_id}-{message_id}",
                    f"BIP-340 tagged hash; {why}",
                    {"op": "taggedHash", "tag": tag, "message": v.hx(message)},
                    {"hash": v.hx(digest)},
                )
            )
    if len(distinct) != len(TAGS) * len(MESSAGES):
        v.fail("tagged hashes collide")
    # The tag is UTF-8 text, hashed as is: no trailing NUL, no case folding, no normalisation.
    for case_id, tag in [
        ("envelope-tag-uppercase", "AGENTLINK/ENVELOPE/V1"),
        ("envelope-tag-v2", "agentlink/envelope/v2"),
        ("non-ascii-tag", "agentlink/é/v1"),
    ]:
        cases.append(
            v.case(
                case_id,
                "BIP-340 tagged hash; the tag is hashed as UTF-8 bytes exactly",
                {"op": "taggedHash", "tag": tag, "message": v.hx(v.sha256(b"abc"))},
                {"hash": v.hx(v.tagged_hash(tag, v.sha256(b"abc")))},
            )
        )
    return cases


SCHEMA = v.case_schema(
    SUITE,
    "BIP-340 tagged hash of `message` (hex) under `tag` (UTF-8 text); expected 32-byte hex.",
    {"taggedHash": ({"tag": v.STRING, "message": v.HEX}, [{"hash": v.hexn(32)}])},
)

if __name__ == "__main__":
    v.main(
        suite=SUITE,
        version=VERSION,
        script="tools/vectors/generate_tagged_hash.py",
        libraries=[],
        build=build,
        schema=SCHEMA,
        doc=__doc__,
    )
