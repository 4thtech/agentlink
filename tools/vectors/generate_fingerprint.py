#!/usr/bin/env python3
"""Independent generator for the `fingerprint` suite: owner and agent fingerprints and the sender
code (M1-1h; sender code M1-1-sc).

04 §2.9 (G-23), display only:
  owner fingerprint = taggedHash("agentlink/owner-fingerprint/v1", ownerEvm || ownerNostr || ownerEnc)
                      over the raw 20, 32 and 32 bytes from the card;
  agent fingerprint = taggedHash("agentlink/agent-fingerprint/v1", agentId) over the raw 20 bytes;
  sender code       = taggedHash("agentlink/sender-code/v1", from) over the 32 raw bytes of an
                      unknown sender's `from` key (D-72, IR-D-72-1 F07), shown in the short form;
  short form        = the first 4 bytes as 8 upper-case hex digits in two groups joined by U+00B7;
  long form         = all 32 bytes as 64 hex digits (upper case, like the short form; the domain
                      claim's `fp`, 04 §2.7, is the long owner fingerprint in lower case).
Inputs are given as the card spells them (0x + lowercase hex, 04 §2.4.1); `from` as the envelope
spells it (64 lowercase hex, no prefix). The tagged hash is
CPython's hashlib (BIP-340 definition); keys are derived from synthetic test seeds.

Usage: python3 -I tools/vectors/generate_fingerprint.py --check [FILE] | --write
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import vectorlib as v  # noqa: E402

SUITE = "fingerprint"
VERSION = 2
SPEC = "04 §2.9 fingerprints"
OWNER_TAG = "agentlink/owner-fingerprint/v1"
AGENT_TAG = "agentlink/agent-fingerprint/v1"
SENDER_TAG = "agentlink/sender-code/v1"


def forms(digest):
    short = digest[:4].hex().upper()
    return {
        "digest": digest.hex(),
        "short": short[:4] + "·" + short[4:],
        "long": digest.hex().upper(),
        "domainClaimFp": digest.hex(),
    }


def owner(label):
    return {
        "ownerEvm": v.evm_address(v.det(f"fingerprint/{label}/owner/evm", 32)),
        "ownerNostr": "0x" + v.hx(v.xonly_public_key(v.det(f"fingerprint/{label}/owner/nostr", 32))),
        "ownerEnc": "0x" + v.hx(v.x25519_public_key(v.det(f"fingerprint/{label}/owner/enc", 32))),
    }


def owner_digest(o):
    raw = bytes.fromhex(o["ownerEvm"][2:]) + bytes.fromhex(o["ownerNostr"][2:]) + bytes.fromhex(o["ownerEnc"][2:])
    if len(raw) != 84:
        v.fail("owner keys are not 20 + 32 + 32 bytes")
    return v.tagged_hash(OWNER_TAG, raw)


def build():
    cases = []
    owners = {label: owner(label) for label in ("a", "b")}
    for label, o in owners.items():
        f = forms(owner_digest(o))
        cases.append(v.case(f"owner-{label}", f"{SPEC}: owner fingerprint over ownerEvm, ownerNostr and ownerEnc", {"op": "ownerFingerprint", **o}, f))
    # A card that copies another owner's ownerNostr still gets another fingerprint (it covers ownerEvm).
    copied = {**owners["b"], "ownerNostr": owners["a"]["ownerNostr"]}
    if owner_digest(copied) == owner_digest(owners["a"]):
        v.fail("copied ownerNostr gives the same fingerprint")
    cases.append(v.case("owner-copied-owner-nostr", f"{SPEC}: another owner's ownerNostr with this owner's ownerEvm gives a different fingerprint", {"op": "ownerFingerprint", **copied}, forms(owner_digest(copied))))
    for label in ("a", "b"):
        agent_id = v.evm_address(v.det(f"fingerprint/{label}/agent/evm", 32))
        cases.append(
            v.case(
                f"agent-{label}",
                f"{SPEC}: agent fingerprint over the raw 20-byte agent ID",
                {"op": "agentFingerprint", "agentId": agent_id},
                forms(v.tagged_hash(AGENT_TAG, bytes.fromhex(agent_id[2:]))),
            )
        )
    # The two labels separate the two kinds: the same 20 bytes under each tag differ.
    agent_id = v.evm_address(v.det("fingerprint/a/agent/evm", 32))
    if v.tagged_hash(AGENT_TAG, bytes.fromhex(agent_id[2:])) == v.tagged_hash(OWNER_TAG, bytes.fromhex(agent_id[2:])):
        v.fail("tags collide")
    # Sender code (04 §2.9, D-72): an unknown sender's 32-byte `from` key; it has no card.
    sender_from = v.hx(v.xonly_public_key(v.det("fingerprint/unknown-sender/nostr", 32)))
    if len(bytes.fromhex(sender_from)) != 32:
        v.fail("sender `from` is not 32 bytes")
    sender_digest = v.tagged_hash(SENDER_TAG, bytes.fromhex(sender_from))
    if sender_digest == v.tagged_hash(AGENT_TAG, bytes.fromhex(sender_from)):
        v.fail("sender-code tag collides with the agent-fingerprint tag")
    cases.append(
        v.case(
            "sender-code",
            f"{SPEC}: sender code of an unknown sender over the 32 raw bytes of its `from` key (D-72)",
            {"op": "senderCode", "from": sender_from},
            # The sender code is shown in the short form only: no long form, no domain claim.
            {k: forms(sender_digest)[k] for k in ("digest", "short")},
        )
    )
    return cases


FORMS = {
    "digest": v.hexn(32),
    "short": {"type": "string", "pattern": "^[0-9A-F]{4}·[0-9A-F]{4}$"},
    "long": {"type": "string", "pattern": "^[0-9A-F]{64}$"},
    "domainClaimFp": v.hexn(32),
}
BYTES32 = {"type": "string", "pattern": "^0x[0-9a-f]{64}$"}
NOSTR_KEY = v.hexn(32)
SCHEMA = v.case_schema(
    SUITE,
    "04 §2.9 fingerprints and the sender code: the 32-byte digest (hex), the short form (8 upper-case hex digits in two "
    "groups joined by U+00B7), the long form (64 upper-case hex digits) and the domain claim `fp` "
    "(the long form in lower case). A sender code (D-72) has the digest and the short form only.",
    {
        "ownerFingerprint": ({"ownerEvm": v.ADDRESS, "ownerNostr": BYTES32, "ownerEnc": BYTES32}, [FORMS]),
        "agentFingerprint": ({"agentId": v.ADDRESS}, [FORMS]),
        "senderCode": ({"from": NOSTR_KEY}, [{k: FORMS[k] for k in ("digest", "short")}]),
    },
)

if __name__ == "__main__":
    v.main(
        suite=SUITE,
        version=VERSION,
        script="tools/vectors/generate_fingerprint.py",
        libraries=["cryptography", "coincurve", "pycryptodome"],
        build=build,
        schema=SCHEMA,
        doc=__doc__,
    )
