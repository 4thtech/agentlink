#!/usr/bin/env python3
"""Independent generator for the `encodings` suite: canonical binary encodings (M1-1h).

04 §2.4.1 on docs/canonical-encodings (pending merge; regenerate if its review changes it): every
binary value has exactly one spelling, decided by its field name. The rows:
  0x + 40 lowercase hex (address)          e.g. agent, agentEvm, ownerEvm
  0x + 64 lowercase hex (bytes32)          e.g. recordId, salt, envelopeHash, card ownerNostr
  0x + 130 lowercase hex (EOA signature)   e.g. cardSig
  decimal string (uint256)                 maxFee, nonce: no sign, no leading zero, in range
  64 lowercase hex (Nostr key)             e.g. envelope from, OwnerAction owner
  128 lowercase hex (BIP-340 signature)    envelope sig, SignedOwnerAction sig
  64 lowercase hex (digest)                e.g. actionDigest, termsHash
  base64url without padding                e.g. id, kid, inviteId, nonce
Non-canonical forms are rejected, never normalised: upper or mixed case (EIP-55 included), a
missing or extra 0x, 0X, a wrong length, whitespace; padded base64url, + or /, non-zero trailing
bits; a signed, zero-led or out-of-range decimal. Equality compares decoded bytes, so the card's
`ownerNostr` (0x + 64 hex) and an OwnerAction `owner` (64 hex) for the same key are equal.

The reference decoder below is this generator's own reading of the table, written with Python's
`re` and `base64` only. Values are synthetic test values (public keys, hashes), not secrets.

Usage: python3 -I tools/vectors/generate_encodings.py --check [FILE] | --write
"""

import base64
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import vectorlib as v  # noqa: E402

SUITE = "encodings"
VERSION = 1
SPEC = "04 §2.4.1 (docs/canonical-encodings, pending merge)"

CLASSES = {
    "address": ("0x", 20),
    "bytes32": ("0x", 32),
    "ecdsa": ("0x", 65),
    "nostr-key": ("", 32),
    "bip340-sig": ("", 64),
    "digest": ("", 32),
}
FIELD_CLASS = {
    "agent": "address",
    "agentEvm": "address",
    "ownerEvm": "address",
    "recordId": "bytes32",
    "salt": "bytes32",
    "envelopeHash": "bytes32",
    "ownerNostr": "bytes32",
    "cardSig": "ecdsa",
    "maxFee": "uint256",
    "nonceUint256": "uint256",
    "from": "nostr-key",
    "owner": "nostr-key",
    "sig": "bip340-sig",
    "actionDigest": "digest",
    "termsHash": "digest",
    "id": "base64url",
    "kid": "base64url",
    "inviteId": "base64url",
    "nonce": "base64url",
}


def decode(field, value):
    kind = FIELD_CLASS[field]
    if not isinstance(value, str):
        raise ValueError("not a string")
    if kind == "uint256":
        if not re.fullmatch(r"0|[1-9][0-9]*", value) or int(value) >= 2**256:
            raise ValueError("not a canonical uint256")
        return int(value).to_bytes(32, "big")
    if kind == "base64url":
        return v.unb64u(value)
    prefix, size = CLASSES[kind]
    if not value.startswith(prefix) or not re.fullmatch(r"[0-9a-f]{%d}" % (2 * size), value[len(prefix) :]):
        raise ValueError("not canonical hex")
    return bytes.fromhex(value[len(prefix) :])


def build():
    cases = []

    def ok(case_id, field, value, why=""):
        cases.append(v.case(f"decode-{case_id}", f"{SPEC}: {field}{why}", {"op": "decode", "field": field, "value": value}, {"bytes": v.hx(decode(field, value))}))

    def bad(case_id, field, value, why):
        try:
            decode(field, value)
            v.fail(f"{case_id} decodes")
        except ValueError:
            pass
        cases.append(v.case(f"decode-reject-{case_id}", f"{SPEC}: {field} {why}; rejected, never normalised", {"op": "decode", "field": field, "value": value}, {"outcome": "reject"}))

    address = v.evm_address(v.det("encodings/agent/evm", 32))
    checksummed = v.eip55(address)
    if checksummed == address or checksummed == "0x" + address[2:].upper():
        v.fail("pick an address whose EIP-55 form is mixed case")
    ok("address", "agent", address)
    ok("address-owner-evm", "ownerEvm", address)
    bad("address-eip55", "agent", checksummed, "in EIP-55 mixed case")
    bad("address-uppercase", "agent", "0x" + address[2:].upper(), "in upper-case hex")
    bad("address-no-prefix", "agent", address[2:], "without 0x")
    bad("address-capital-prefix", "agent", "0X" + address[2:], "with 0X")
    bad("address-39-hex", "agent", address[:-1], "with 39 hex digits")
    bad("address-41-hex", "agent", address + "0", "with 41 hex digits")
    bad("address-whitespace", "agent", " " + address, "with leading whitespace")

    b32 = v.sha256(b"encodings/record")
    ok("bytes32", "recordId", "0x" + b32.hex())
    ok("bytes32-envelope-hash", "envelopeHash", "0x" + b32.hex())
    bad("bytes32-uppercase", "recordId", "0x" + b32.hex().upper(), "in upper-case hex")
    bad("bytes32-no-prefix", "recordId", b32.hex(), "without 0x")
    bad("bytes32-63-hex", "recordId", "0x" + b32.hex()[:-1], "with 63 hex digits")
    bad("salt-base64url", "salt", v.b64u(b32), "as base64url (a proof body's salt is EVM-native)")
    bad("record-id-base64url", "recordId", v.b64u(b32), "as base64url")

    sig65 = v.sha256(b"encodings/r") + v.sha256(b"encodings/s") + b"\x1b"
    ok("ecdsa", "cardSig", "0x" + sig65.hex())
    bad("ecdsa-64-bytes", "cardSig", "0x" + sig65[:64].hex(), "of 64 bytes")
    bad("ecdsa-uppercase", "cardSig", "0x" + sig65.hex().upper(), "in upper-case hex")
    bad("ecdsa-no-prefix", "cardSig", sig65.hex(), "without 0x")

    for case_id, value in [("uint256-zero", "0"), ("uint256", "1500000"), ("uint256-max", str(2**256 - 1))]:
        ok(case_id, "maxFee", value)
    for case_id, value, why in [
        ("uint256-leading-zero", "01500", "with a leading zero"),
        ("uint256-plus", "+1500", "with a sign"),
        ("uint256-minus", "-1", "negative"),
        ("uint256-overflow", str(2**256), "of 2^256"),
        ("uint256-fraction", "1500.0", "with a fraction"),
        ("uint256-exponent", "1e3", "in exponent form"),
        ("uint256-hex", "0x5dc", "in hex"),
        ("uint256-whitespace", "1500 ", "with trailing whitespace"),
        ("uint256-empty", "", "empty"),
    ]:
        bad(case_id, "maxFee", value, why)

    key = v.xonly_public_key(v.det("encodings/owner/nostr", 32))
    ok("nostr-key", "from", key.hex())
    ok("nostr-key-owner", "owner", key.hex())
    bad("nostr-key-0x", "owner", "0x" + key.hex(), "with 0x (Nostr-native)")
    bad("nostr-key-uppercase", "from", key.hex().upper(), "in upper-case hex")
    bad("nostr-key-63-hex", "from", key.hex()[:-1], "with 63 hex digits")
    ok("card-owner-nostr", "ownerNostr", "0x" + key.hex(), " (the card's spelling of a Nostr key)")
    bad("card-owner-nostr-no-prefix", "ownerNostr", key.hex(), "without 0x (the card spells it 0x + 64 hex)")

    bip340 = v.sha256(b"encodings/R") + v.sha256(b"encodings/s2")
    ok("bip340-sig", "sig", bip340.hex())
    bad("bip340-sig-0x", "sig", "0x" + bip340.hex(), "with 0x")
    bad("bip340-sig-uppercase", "sig", bip340.hex().upper(), "in upper-case hex")

    digest = v.sha256(b"encodings/action")
    ok("digest", "actionDigest", digest.hex())
    ok("digest-terms", "termsHash", digest.hex())
    bad("digest-0x", "actionDigest", "0x" + digest.hex(), "with 0x (signed only under a Nostr key)")
    bad("digest-base64url", "termsHash", v.b64u(digest), "as base64url")

    raw16 = bytes.fromhex("fbff3e0f00ff10e0f8fe7d3c1b0a99ee")
    text = v.b64u(raw16)
    ok("base64url", "id", text)
    ok("base64url-invite-id", "inviteId", text)
    bad("base64url-padded", "id", text + "==", "with padding")
    bad("base64url-standard-alphabet", "id", text.replace("-", "+").replace("_", "/"), "with + and /")
    alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    bad("base64url-trailing-bits", "id", text[:-1] + alphabet[alphabet.index(text[-1]) | 1], "with non-zero trailing bits")
    bad("base64url-whitespace", "kid", text[:11] + " " + text[11:], "with whitespace")
    bad("base64url-impossible-length", "nonce", text + "AAA", "with an impossible length (4n + 1 characters)")
    if base64.urlsafe_b64decode(text + "==") != raw16:
        v.fail("base64url round trip")

    # Cross-class equality: decode both sides, compare bytes (§2.4.1 "Compare bytes, never strings").
    def eq(case_id, a, b, accept, why):
        try:
            result = decode(*a) == decode(*b)
        except ValueError:
            result = False
        if result != accept:
            v.fail(f"{case_id}: unexpected")
        cases.append(
            v.case(
                f"equal-{case_id}",
                f"{SPEC}: {why}",
                {"op": "equalBytes", "a": {"field": a[0], "value": a[1]}, "b": {"field": b[0], "value": b[1]}},
                {"outcome": "accept" if accept else "reject"},
            )
        )

    other = v.xonly_public_key(v.det("encodings/other/nostr", 32))
    eq("owner-and-card-owner-nostr", ("owner", key.hex()), ("ownerNostr", "0x" + key.hex()), True, "an OwnerAction owner and the card's ownerNostr for the same key are equal as bytes")
    eq("from-and-card-agent-nostr", ("from", key.hex()), ("ownerNostr", "0x" + key.hex()), True, "an envelope from and a card bytes32 key compare as bytes")
    eq("owner-other-key", ("owner", other.hex()), ("ownerNostr", "0x" + key.hex()), False, "different keys are not equal")
    eq("owner-with-0x", ("owner", "0x" + key.hex()), ("ownerNostr", "0x" + key.hex()), False, "a string-equal but non-canonical owner fails its parse first")
    eq("card-without-0x", ("owner", key.hex()), ("ownerNostr", key.hex()), False, "a card key without 0x fails its parse first")
    eq("address-checksummed", ("agent", checksummed), ("agentEvm", address), False, "an EIP-55 address fails its parse; nothing lower-cases it")
    return cases


FIELD = {"enum": sorted(FIELD_CLASS)}
OPERAND = v.strict_object({"field": FIELD, "value": v.STRING})
SCHEMA = v.case_schema(
    SUITE,
    "04 §2.4.1 canonical encodings. `decode`: the value of a field, decoded by the field's class, as "
    "hex bytes (uint256 as 32 big-endian bytes), or a rejection. `equalBytes`: accept when both "
    "values parse and decode to the same bytes, otherwise reject.",
    {
        "decode": ({"field": FIELD, "value": v.STRING}, [{"bytes": v.HEX}, v.REJECT]),
        "equalBytes": ({"a": OPERAND, "b": OPERAND}, [v.ACCEPT, v.REJECT]),
    },
)

if __name__ == "__main__":
    v.main(
        suite=SUITE,
        version=VERSION,
        script="tools/vectors/generate_encodings.py",
        libraries=["coincurve", "pycryptodome"],
        build=build,
        schema=SCHEMA,
        doc=__doc__,
    )
