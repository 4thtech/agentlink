#!/usr/bin/env python3
"""Independent generator for the `ucd15-table` suite: the pinned UCD 15.0.0 table (M1-21-b, D-74).

The `terms` character rule (04 §3.4 "Characters") refuses every code point whose UCD 15.0.0
General_Category is Cc, Cf, Zl, Zp, Co, Cs or Cn, from a table shipped in @4thtech-io/types. These
vectors check that table in every runtime that loads it: the hash of its canonical serialization,
the number of code points per refused category, and single lookups.

This generator does not use the table or its generator (tools/unicode/generate_ucd15_table.py). It
parses the vendored UCD file tools/unicode/ucd-15.0.0/DerivedGeneralCategory.txt itself, after
checking its SHA-256 against the value pinned below, and checks its parse against the file's own
"Total code points" lines and the size of the code space. When the interpreter's `unicodedata` is at
UCD 15.0.0 (CPython 3.12, as in CI), it also checks every code point's category against it; the
output never depends on it.

Canonical serialization (version 1): the UTF-8 bytes of the line `agentlink/ucd15-refused/v1`
followed by one line `FIRST..LAST;Cat` per maximal run of consecutive code points with the same
refused category, in code point order, with FIRST and LAST in upper-case hex of at least four
digits; every line ends with LF. tableHash = SHA-256 of those bytes, in lower-case hex.

Usage: python3 -I tools/vectors/generate_ucd15_table.py --check [FILE] | --write
"""

import hashlib
import sys
import unicodedata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import vectorlib as v  # noqa: E402

SUITE = "ucd15-table"
VERSION = 1
SOURCE = v.ROOT / "tools" / "unicode" / "ucd-15.0.0" / "DerivedGeneralCategory.txt"
SOURCE_SHA256 = "fe29a45c0882500e591140aaa5c4f5067e6a5d746806148af34400c48b9c06f9"
REFUSED = ["Cc", "Cf", "Zl", "Zp", "Co", "Cs", "Cn"]
SERIALIZATION_TAG = "agentlink/ucd15-refused/v1"
SPEC = "04 §3.4 Characters and Table provenance (D-74, M1-21-b)"
CODE_SPACE = 0x110000

# Code points worth a single lookup: the C0/C1 edges, the characters the spec names (bidi
# controls, zero-width characters, U+FEFF, line and paragraph separators, noncharacters,
# surrogates, private use), code points new in 15.0 (accepted) and unassigned in 15.0 (refused).
LOOKUPS = [
    (0x0000, "C0 NUL"),
    (0x0009, "C0 tab"),
    (0x000A, "C0 line feed"),
    (0x001F, "last C0"),
    (0x0020, "space"),
    (0x0041, "LATIN CAPITAL LETTER A"),
    (0x007E, "TILDE, last printable ASCII"),
    (0x007F, "DEL"),
    (0x0080, "first C1"),
    (0x009F, "last C1"),
    (0x00A0, "NO-BREAK SPACE"),
    (0x00AD, "SOFT HYPHEN"),
    (0x0378, "unassigned in Greek"),
    (0x061C, "ARABIC LETTER MARK"),
    (0x200B, "ZERO WIDTH SPACE"),
    (0x200C, "ZERO WIDTH NON-JOINER"),
    (0x200D, "ZERO WIDTH JOINER"),
    (0x200E, "LEFT-TO-RIGHT MARK"),
    (0x2028, "LINE SEPARATOR"),
    (0x2029, "PARAGRAPH SEPARATOR"),
    (0x202E, "RIGHT-TO-LEFT OVERRIDE"),
    (0x2066, "LEFT-TO-RIGHT ISOLATE"),
    (0x2069, "POP DIRECTIONAL ISOLATE"),
    (0x0415, "CYRILLIC CAPITAL LETTER IE"),
    (0xD800, "first surrogate"),
    (0xDFFF, "last surrogate"),
    (0xE000, "first private use"),
    (0xF8FF, "last BMP private use"),
    (0xFDD0, "first noncharacter of the FDD0 block"),
    (0xFDEF, "last noncharacter of the FDD0 block"),
    (0xFEFF, "ZERO WIDTH NO-BREAK SPACE (BOM)"),
    (0xFFFD, "REPLACEMENT CHARACTER"),
    (0xFFFE, "noncharacter U+FFFE"),
    (0xFFFF, "noncharacter U+FFFF"),
    (0x10EFD, "ARABIC SMALL LOW WORD SAKTA, new in 15.0"),
    (0x11F00, "KAWI SIGN CANDRABINDU, new in 15.0"),
    (0x1E4D0, "NAG MUNDARI LETTER O, new in 15.0"),
    (0x1F6DC, "WIRELESS, new in 15.0"),
    (0x1FAE8, "SHAKING FACE, new in 15.0"),
    (0x31350, "first CJK Extension H ideograph, new in 15.0"),
    (0x323AF, "last CJK Extension H ideograph, new in 15.0"),
    (0x323B0, "unassigned after CJK Extension H"),
    (0x1FABE, "unassigned in 15.0, assigned in a later version"),
    (0x2EBF0, "unassigned in 15.0 (CJK Extension I in 15.1)"),
    (0x1F7D9, "NINE POINTED WHITE STAR, new in 15.0"),
    (0x1F7DA, "unassigned in 15.0, right after U+1F7D9"),
    (0xE0001, "LANGUAGE TAG"),
    (0xE0020, "TAG SPACE"),
    (0xE007F, "CANCEL TAG"),
    (0xE0100, "VARIATION SELECTOR-17"),
    (0xF0000, "first plane 15 private use"),
    (0x10FFFD, "last private use"),
    (0x10FFFE, "noncharacter U+10FFFE"),
    (0x10FFFF, "last code point"),
]


def parse():
    data = SOURCE.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    if digest != SOURCE_SHA256:
        v.fail(f"{SOURCE.relative_to(v.ROOT)} has SHA-256 {digest}, pinned {SOURCE_SHA256}")
    lines = data.decode("utf-8").split("\n")
    if lines[0] != "# DerivedGeneralCategory-15.0.0.txt":
        v.fail(f"{SOURCE.relative_to(v.ROOT)}: not the UCD 15.0.0 file")
    category = [None] * CODE_SPACE
    section_count = 0
    section_category = None
    for line in lines:
        if line.startswith("# Total code points:"):
            stated = int(line.split(":", 1)[1])
            if section_count != stated:
                v.fail(f"{section_category}: parsed {section_count} code points, file states {stated}")
            section_count, section_category = 0, None
            continue
        content = line.split("#", 1)[0].strip()
        if not content:
            continue
        span, name = (part.strip() for part in content.split(";"))
        first, _, last = span.partition("..")
        first = int(first, 16)
        last = int(last, 16) if last else first
        if section_category not in (None, name):
            v.fail(f"U+{first:04X}: category {name} inside the {section_category} section")
        section_category = name
        for cp in range(first, last + 1):
            if category[cp] is not None:
                v.fail(f"U+{cp:04X} listed twice")
            category[cp] = name
        section_count += last - first + 1
    if None in category:
        v.fail(f"U+{category.index(None):04X} has no category in the file")
    if unicodedata.unidata_version == "15.0.0":
        for cp in range(CODE_SPACE):
            if unicodedata.category(chr(cp)) != category[cp]:
                v.fail(f"U+{cp:04X}: file says {category[cp]}, unicodedata 15.0.0 says otherwise")
    return category


def runs(category):
    out = []
    for cp, name in enumerate(category):
        if name not in REFUSED:
            continue
        if out and out[-1][1] == cp - 1 and out[-1][2] == name:
            out[-1][1] = cp
        else:
            out.append([cp, cp, name])
    return out


def serialization(category):
    lines = [SERIALIZATION_TAG] + [f"{a:04X}..{b:04X};{name}" for a, b, name in runs(category)]
    return ("\n".join(lines) + "\n").encode("utf-8")


def build():
    category = parse()
    cases = [
        v.case(
            "table-hash",
            f"{SPEC}: SHA-256 of the canonical serialization of the refused-category table",
            {"op": "tableHash"},
            {
                "hash": v.hx(hashlib.sha256(serialization(category)).digest()),
                "runs": str(len(runs(category))),
            },
        ),
        v.case(
            "category-counts",
            f"{SPEC}: code points per refused category (the file's Total code points)",
            {"op": "categoryCounts"},
            {name: str(category.count(name)) for name in REFUSED},
        ),
    ]
    for cp, why in LOOKUPS:
        name = category[cp]
        cases.append(
            v.case(
                f"category-{cp:04x}",
                f"{SPEC}: U+{cp:04X} {why} is {name} in UCD 15.0.0",
                {"op": "category", "codePoint": cp},
                {"category": name if name in REFUSED else "none"},
            )
        )
    return cases


SCHEMA = v.case_schema(
    SUITE,
    "The pinned UCD 15.0.0 refused-category table of @4thtech-io/types: tableHash (hex SHA-256 of "
    "the canonical serialization, and the number of runs), categoryCounts (decimal counts), and "
    "category (the refused category of one code point, or `none`).",
    {
        "tableHash": ({}, [{"hash": v.hexn(32), "runs": {"type": "string", "pattern": "^[1-9][0-9]*$"}}]),
        "categoryCounts": (
            {},
            [{name: {"type": "string", "pattern": "^(0|[1-9][0-9]*)$"} for name in REFUSED}],
        ),
        "category": (
            {"codePoint": {"type": "integer", "minimum": 0, "maximum": CODE_SPACE - 1}},
            [{"category": {"enum": REFUSED + ["none"]}}],
        ),
    },
)

if __name__ == "__main__":
    v.main(
        suite=SUITE,
        version=VERSION,
        script="tools/vectors/generate_ucd15_table.py",
        libraries=[],
        build=build,
        schema=SCHEMA,
        doc=__doc__,
    )
