#!/usr/bin/env python3
"""Independent generator for the placeholder SHA-256 vector suite (M0-9).

This script is deliberately outside the TypeScript code under test: it uses CPython's hashlib and
nothing from this repository. Every message comes from a published NIST or RFC test value, and the
published digest is written next to it in SOURCES below. The script computes each digest with
hashlib and refuses to write anything unless hashlib agrees with the published value, so a vector
file is only produced when two independent sources agree.

Vectors are generated once and committed. Tests never regenerate them; CI fails if a test run
changes anything under test-vectors/ (docs/process/development-process.md §10, test-vectors/README.md).

Usage (from the repository root):
  python3 tools/vectors/generate_sha256.py --check [FILE]  # compare FILE (default: the committed
                                                           # suite file) with the generator output;
                                                           # writes nothing, exits 1 on mismatch
  python3 tools/vectors/generate_sha256.py --write         # (re)write the committed file; needs a
                                                           # spec change

Every generator under tools/vectors/ supports `--check FILE` the same way; CI runs it for every
committed vectors.json (tools/vectors/check-generators.mjs, IR-M0-9-1 F02).
"""

import argparse
import hashlib
import json
import platform
import sys
from pathlib import Path

SUITE = "placeholder-sha256"
SUITE_VERSION = 1
OUT = Path(__file__).resolve().parents[2] / "test-vectors" / SUITE / "vectors.json"

# (id, source, message hex, repeat count, published SHA-256 digest)
SOURCES = [
    (
        "cavp-shortmsg-len0",
        "NIST CAVP SHAVS, SHA256ShortMsg.rsp, Len = 0",
        "",
        1,
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    ),
    (
        "cavp-shortmsg-len8",
        "NIST CAVP SHAVS, SHA256ShortMsg.rsp, Len = 8",
        "d3",
        1,
        "28969cdfa74a12c82f3bad960b0b000aca2ac329deea5c2328ebc6f2ba9802c1",
    ),
    (
        "cavp-shortmsg-len16",
        "NIST CAVP SHAVS, SHA256ShortMsg.rsp, Len = 16",
        "11af",
        1,
        "5ca7133fa735326081558ac312c620eeca9970d1e70a4b95533d956f072d1f98",
    ),
    (
        "fips180-one-block-abc",
        "FIPS 180-2 Appendix B.1 (NIST example SHA256.pdf): 'abc'",
        b"abc".hex(),
        1,
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    ),
    (
        "fips180-two-block-448bit",
        "FIPS 180-2 Appendix B.2 (RFC 6234 TEST2_1): 448-bit message",
        b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq".hex(),
        1,
        "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    ),
    (
        "rfc6234-test4-640byte",
        "RFC 6234 section 8.5, TEST4: 64-byte string repeated 10 times",
        b"0123456701234567012345670123456701234567012345670123456701234567".hex(),
        10,
        "594847328451bdfa85056225462cc1d867d877fb388df0ce35f25ab5562bfbb5",
    ),
    (
        "fips180-million-a",
        "FIPS 180-2 Appendix B.3 (RFC 6234 TEST3): one million 'a'",
        b"a".hex(),
        1000000,
        "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
    ),
]


def build():
    cases = []
    for case_id, source, message_hex, repeat, published in SOURCES:
        digest = hashlib.sha256(bytes.fromhex(message_hex) * repeat).hexdigest()
        if digest != published:
            sys.exit(f"{case_id}: hashlib gives {digest}, the publication says {published}; nothing written")
        cases.append(
            {
                "id": case_id,
                "source": source,
                "input": {"hex": message_hex, "repeat": repeat},
                "expected": {"sha256": digest},
            }
        )
    return {
        "$schema": "../schema/vector-file.schema.json",
        "suite": SUITE,
        "version": SUITE_VERSION,
        "generator": {
            "tool": "cpython-hashlib",
            "version": platform.python_version(),
            "script": "tools/vectors/generate_sha256.py",
        },
        "cases": cases,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument(
        "--check",
        nargs="?",
        const=str(OUT),
        metavar="FILE",
        help="compare FILE (default: the committed suite file) with the generator output",
    )
    mode.add_argument("--write", action="store_true", help="write the committed file")
    args = parser.parse_args()

    document = build()
    if args.write:
        OUT.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
        print(f"wrote {OUT}")
        return

    target = Path(args.check)
    committed_text = target.read_text(encoding="utf-8")
    try:
        committed_version = json.loads(committed_text)["generator"]["version"]
    except (ValueError, KeyError, TypeError):
        sys.exit(f"{target}: not a vector file")
    # The generator's own version (the Python version) may differ between machines; everything
    # else must match byte for byte, as in vectorlib.py (M1-1h-d).
    document["generator"]["version"] = committed_version
    if committed_text != json.dumps(document, indent=2) + "\n":
        # Exit status 3 means "compared and found a difference" (vectorlib.MISMATCH,
        # generators.mjs MISMATCH_EXIT); every other failure exits with 1.
        print(f"{target} differs from the generator output", file=sys.stderr)
        sys.exit(3)
    print(f"{target}: matches the generator output ({len(document['cases'])} cases)")


if __name__ == "__main__":
    main()
