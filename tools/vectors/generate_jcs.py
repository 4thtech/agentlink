#!/usr/bin/env python3
"""Independent generator for the `jcs` suite: RFC 8785 JSON Canonicalization Scheme (M1-1h).

Canonical forms come from Trail of Bits' `rfc8785` package, and the generator refuses to write
unless it agrees with every value published in RFC 8785 (section 3.2.2 to 3.2.4 samples and the
Appendix B number table). AgentLink cases cover shapes the protocol hashes (04 §3.1 envelope
header, 04 §2.5.1 owner action) and the rejections RFC 8785 requires (lone surrogates, NaN and
Infinity). Cases are inputs as JSON text, so the suite exercises parse + canonicalise; `number`
cases give an IEEE 754 double as 16 hex digits.

Usage: python3 -I tools/vectors/generate_jcs.py --check [FILE] | --write
"""

import json
import math
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import vectorlib as v  # noqa: E402

SUITE = "jcs"
VERSION = 1
RFC = "RFC 8785"

# RFC 8785 Appendix B, Table 1: (IEEE 754 hex, JSON representation or None for an error).
APPENDIX_B = [
    ("0000000000000000", "0"),
    ("8000000000000000", "0"),
    ("0000000000000001", "5e-324"),
    ("8000000000000001", "-5e-324"),
    ("7fefffffffffffff", "1.7976931348623157e+308"),
    ("ffefffffffffffff", "-1.7976931348623157e+308"),
    ("4340000000000000", "9007199254740992"),
    ("c340000000000000", "-9007199254740992"),
    ("4430000000000000", "295147905179352830000"),
    ("7fffffffffffffff", None),
    ("7ff0000000000000", None),
    ("44b52d02c7e14af5", "9.999999999999997e+22"),
    ("44b52d02c7e14af6", "1e+23"),
    ("44b52d02c7e14af7", "1.0000000000000001e+23"),
    ("444b1ae4d6e2ef4e", "999999999999999700000"),
    ("444b1ae4d6e2ef4f", "999999999999999900000"),
    ("444b1ae4d6e2ef50", "1e+21"),
    ("3eb0c6f7a0b5ed8c", "9.999999999999997e-7"),
    ("3eb0c6f7a0b5ed8d", "0.000001"),
    ("41b3de4355555553", "333333333.3333332"),
    ("41b3de4355555554", "333333333.33333325"),
    ("41b3de4355555555", "333333333.3333333"),
    ("41b3de4355555556", "333333333.3333334"),
    ("41b3de4355555557", "333333333.33333343"),
    ("becbf647612f3696", "-0.0000033333333333333333"),
    ("43143ff3c1cb0959", "1424953923781206.2"),
]
APPENDIX_B_NAMES = {
    "0000000000000000": "zero",
    "8000000000000000": "minus-zero",
    "0000000000000001": "min-pos",
    "8000000000000001": "min-neg",
    "7fefffffffffffff": "max-pos",
    "ffefffffffffffff": "max-neg",
    "4340000000000000": "max-pos-int",
    "c340000000000000": "max-neg-int",
    "4430000000000000": "approx-2-pow-68",
    "7fffffffffffffff": "nan",
    "7ff0000000000000": "infinity",
    "43143ff3c1cb0959": "round-to-even",
}

# RFC 8785 section 3.2.2 input, section 3.2.3 canonical form and section 3.2.4 UTF-8 bytes.
RFC_3_2_2_INPUT = (
    '{\n  "numbers": [333333333.33333329, 1E30, 4.50,\n              2e-3, 0.000000000000000000000000001],\n'
    '  "string": "\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/",\n'
    '  "literals": [null, true, false]\n}'
)
# The RFC prints these bytes in rows of 20.
RFC_3_2_4_ROWS = [
    "7b 22 6c 69 74 65 72 61 6c 73 22 3a 5b 6e 75 6c 6c 2c 74 72",
    "75 65 2c 66 61 6c 73 65 5d 2c 22 6e 75 6d 62 65 72 73 22 3a",
    "5b 33 33 33 33 33 33 33 33 33 2e 33 33 33 33 33 33 33 2c 31",
    "65 2b 33 30 2c 34 2e 35 2c 30 2e 30 30 32 2c 31 65 2d 32 37",
    "5d 2c 22 73 74 72 69 6e 67 22 3a 22 e2 82 ac 24 5c 75 30 30",
    "30 66 5c 6e 41 27 42 5c 22 5c 5c 5c 5c 5c 22 2f 22 7d",
]
RFC_3_2_3_INPUT = (
    '{\n  "\\u20ac": "Euro Sign",\n  "\\r": "Carriage Return",\n'
    '  "\\ufb33": "Hebrew Letter Dalet With Dagesh",\n  "1": "One",\n'
    '  "\\ud83d\\ude00": "Emoji: Grinning Face",\n  "\\u0080": "Control",\n'
    '  "\\u00f6": "Latin Small Letter O With Diaeresis"\n}'
)
RFC_3_2_3_ORDER = [
    "Carriage Return",
    "One",
    "Control",
    "Latin Small Letter O With Diaeresis",
    "Euro Sign",
    "Emoji: Grinning Face",
    "Hebrew Letter Dalet With Dagesh",
]

# AgentLink shapes and edge cases (no published value; canonical form from `rfc8785`).
AGENTLINK_TEXTS = [
    (
        "agentlink-envelope-header",
        "04 §3.1 AEAD additional-data object {v, id, thread, from, createdAt, recipients}",
        '{"v":1,"thread":"dGhyZWFkLXRocmVhZC0wMQ","id":"aWQtaWQtaWQtaWQtMDAxMQ",'
        '"from":"d1d6e1b2e0f1c3a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2",'
        '"createdAt":1760000000,"recipients":[{"wk":"d2s","kid":"a2lk","enc":"ZW5j"},'
        '{"kid":"a2lkMg","enc":"ZW5jMg","wk":"d2sy"}]}',
    ),
    (
        "agentlink-owner-action",
        "04 §2.5.1 OwnerAction shape (agent.revoke)",
        '{"v":1,"agent":"0x00000000000000000000000000000000000000aa","owner":"'
        + "ab" * 32
        + '","op":"agent.revoke","params":{"reason":"retired"},"nonce":"AAAAAAAAAAAAAAAAAAAAAA",'
        '"issuedAt":1760000000,"expiresAt":0}',
    ),
    ("empty-object", "RFC 8785 §3.2.1 (no whitespace)", " { } "),
    ("empty-array", "RFC 8785 §3.2.1 (no whitespace)", "[ ]"),
    (
        "nested-sort",
        "RFC 8785 §3.2.3 (recursive sort; arrays keep their order)",
        '{"b":[{"z":1,"a":2},{"y":[3,{"d":4,"c":5}]}],"a":{"c":{"b":1,"a":2},"b":null}}',
    ),
    (
        "string-escapes",
        "RFC 8785 §3.2.2.2 (control characters, quote, backslash, solidus kept as is)",
        '{"s":"\\u0000\\u0007\\b\\t\\n\\u000b\\f\\r\\u001f \\"\\\\/\\u007f\\u00e9\\u2028"}',
    ),
    (
        "non-bmp-key-sort",
        "RFC 8785 §3.2.3 (UTF-16 code-unit order: U+FFFF sorts after a surrogate pair)",
        '{"\\uffff":1,"\\ud83d\\ude00":2,"\\ue000":3}',
    ),
    (
        "integers",
        "RFC 8785 §3.2.2.3 (integer-valued numbers, exponent forms)",
        "[0,-0,1,-1,9007199254740991,-9007199254740991,1E2,1e-2,100e-2,0.1e1,12345678901234567890]",
    ),
    ("literals", "RFC 8785 §3.2.2.1", "[true,false,null]"),
    ("unicode-as-is", "RFC 8785 §3.2.2.2 (non-ASCII kept as UTF-8, not escaped)", '"\\u00f6\\u20ac\\ud83d\\ude00"'),
]

REJECT_TEXTS = [
    ("lone-high-surrogate-value", '{"a":"\\ud800"}'),
    ("lone-low-surrogate-value", '["\\udc00x"]'),
    ("lone-surrogate-key", '{"\\udbff":1}'),
    ("reversed-surrogate-pair", '"\\ude00\\ud83d"'),
]


def double_from_hex(bits):
    return struct.unpack(">d", bytes.fromhex(bits))[0]


def canonical_or_none(value):
    try:
        return v.jcs(value)
    except Exception:
        return None


def parse(text):
    # Python's json keeps lone surrogates as str code points, which rfc8785 then rejects. Large
    # integers become floats first, as in ECMAScript (the RFC's data model is IEEE 754 doubles).
    return json.loads(text, parse_int=lambda s: float(int(s)) if abs(int(s)) > 2**53 - 1 else int(s))


def build():
    cases = []
    published_bytes = bytes.fromhex("".join(RFC_3_2_4_ROWS).replace(" ", ""))
    sample = v.jcs(parse(RFC_3_2_2_INPUT))
    if sample != published_bytes:
        v.fail("rfc8785 disagrees with RFC 8785 §3.2.4")
    cases.append(
        v.case(
            "rfc8785-3-2-4-sample",
            f"{RFC} §3.2.2 input, §3.2.3 canonical form, §3.2.4 UTF-8 bytes (published)",
            {"op": "canonicalize", "json": RFC_3_2_2_INPUT},
            {"utf8": v.hx(sample), "sha256": v.hx(v.sha256(sample))},
        )
    )

    sorted_sample = v.jcs(parse(RFC_3_2_3_INPUT))
    values = list(json.loads(sorted_sample.decode("utf-8")).values())
    if values != RFC_3_2_3_ORDER:
        v.fail("rfc8785 disagrees with the RFC 8785 §3.2.3 sort order")
    cases.append(
        v.case(
            "rfc8785-3-2-3-sorting",
            f"{RFC} §3.2.3 sorting sample (published property order)",
            {"op": "canonicalize", "json": RFC_3_2_3_INPUT},
            {"utf8": v.hx(sorted_sample), "sha256": v.hx(v.sha256(sorted_sample))},
        )
    )

    for bits, published in APPENDIX_B:
        number = double_from_hex(bits)
        name = APPENDIX_B_NAMES.get(bits, bits)
        if published is None:
            if not (math.isnan(number) or math.isinf(number)) or canonical_or_none(number) is not None:
                v.fail(f"rfc8785 accepts {bits}")
            cases.append(
                v.case(
                    f"rfc8785-b-{name}",
                    f"{RFC} Appendix B ({bits}): NaN and Infinity MUST cause an error (§3.2.2.3)",
                    {"op": "number", "ieee754": bits},
                    {"outcome": "reject"},
                )
            )
            continue
        text = v.jcs(number).decode("ascii")
        if text != published:
            v.fail(f"rfc8785 gives {text} for {bits}, RFC 8785 Appendix B says {published}")
        cases.append(
            v.case(
                f"rfc8785-b-{name}",
                f"{RFC} Appendix B ({bits}) (published)",
                {"op": "number", "ieee754": bits},
                {"json": text},
            )
        )

    for case_id, source, text in AGENTLINK_TEXTS:
        canonical = v.jcs(parse(text))
        cases.append(
            v.case(
                case_id,
                source,
                {"op": "canonicalize", "json": text},
                {"utf8": v.hx(canonical), "sha256": v.hx(v.sha256(canonical))},
            )
        )

    for case_id, text in REJECT_TEXTS:
        if canonical_or_none(parse(text)) is not None:
            v.fail(f"rfc8785 accepts {case_id}")
        cases.append(
            v.case(
                case_id,
                f"{RFC} §3.2.2.2: lone surrogates MUST cause an error",
                {"op": "canonicalize", "json": text},
                {"outcome": "reject"},
            )
        )
    return cases


SCHEMA = v.case_schema(
    SUITE,
    "RFC 8785 JCS. `canonicalize`: parse `json` (JSON text) and canonicalise; expected UTF-8 bytes "
    "as hex and their SHA-256, or a rejection. `number`: serialise the IEEE 754 double given as 16 "
    "hex digits (big-endian bits); expected JSON text, or a rejection.",
    {
        "canonicalize": (
            {"json": v.STRING},
            [{"utf8": v.HEX, "sha256": v.hexn(32)}, v.REJECT],
        ),
        "number": (
            {"ieee754": {"type": "string", "pattern": "^[0-9a-f]{16}$"}},
            [{"json": v.STRING}, v.REJECT],
        ),
    },
)

if __name__ == "__main__":
    v.main(
        suite=SUITE,
        version=VERSION,
        script="tools/vectors/generate_jcs.py",
        libraries=["rfc8785"],
        build=build,
        schema=SCHEMA,
        doc=__doc__,
    )
