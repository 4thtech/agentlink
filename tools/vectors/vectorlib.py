"""Shared helpers for the independent vector generators (M1-1h).

Nothing here imports repository TypeScript or any code under test. Primitives come from pinned,
well-known Python libraries (tools/vectors/requirements.txt, installed with --require-hashes):
`cryptography` (OpenSSL), `coincurve` (libsecp256k1), `pycryptodome` (Keccak-256), `pyhpke` and
`rfc8785`. This module only composes them the way docs/foundation/04 specifies; every composition
is cross-checked against published values in the generator that uses it.

Each generator script imports this module from its own directory. Scripts run with `python3 -I`
(isolated mode), so they add their own directory to sys.path explicitly and nothing else.

Every generator:
  --write          writes test-vectors/<suite>/vectors.json and case.schema.json
  --check [FILE]   writes nothing; exits 1 unless FILE (default: the committed vectors.json) is
                   byte for byte what the generator produces. Only generator.version (the Python
                   version of the machine that wrote it) may differ. With the default FILE, the
                   committed case.schema.json is checked the same way.
"""

import argparse
import base64
import hashlib
import hmac as _hmac
import json
import platform
import re
import sys
from importlib import metadata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
REQUIREMENTS = HERE / "requirements.txt"
SOURCES = HERE / "sources"

ID_PATTERN = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")


def fail(message):
    sys.exit(f"vector generator: {message}; nothing written")


# `--check` exit status when it compared and found a difference (tools/vectors/generators.mjs
# MISMATCH_EXIT). Distinct from 1 (fail(), any other error) and 2 (argparse), so a broken
# environment is never reported as drifted vectors (M1-1h-d).
MISMATCH = 3


def mismatch(target, committed_text, expected_text):
    """Report a `--check` difference, naming where it starts, and exit with MISMATCH."""
    where = "the file text (formatting or key order)"
    try:
        committed = json.loads(committed_text)
        expected = json.loads(expected_text)
        if {k: x for k, x in committed.items() if k != "cases"} != {
            k: x for k, x in expected.items() if k != "cases"
        }:
            where = "the file header (suite, version, generator, runtimes)"
        else:
            old, new = committed.get("cases"), expected["cases"]
            if not isinstance(old, list) or len(old) != len(new):
                where = f"the case count ({len(old) if isinstance(old, list) else '?'} committed, {len(new)} generated)"
            else:
                for a, b in zip(old, new):
                    if a != b:
                        where = f"case {b['id']}"
                        break
    except (ValueError, AttributeError, KeyError, TypeError):
        where = "the file text (not a vector file)"
    print(f"{target} differs from the generator output, first at {where}", file=sys.stderr)
    sys.exit(MISMATCH)


# --- pinned dependencies -------------------------------------------------------------------------


def pinned_versions():
    pins = {}
    for line in REQUIREMENTS.read_text(encoding="utf-8").splitlines():
        match = re.match(r"^([A-Za-z0-9_.-]+)==([^\s;\\]+)", line)
        if match:
            pins[match.group(1).lower()] = match.group(2)
    return pins


def tool_string(libraries):
    """The generator tool: the libraries this suite uses, at the pinned versions. Refuses to run
    with any other installed version, so a vector file always names exactly what produced it."""
    pins = pinned_versions()
    parts = ["hashlib"]
    for name in libraries:
        pinned = pins.get(name.lower())
        if pinned is None:
            fail(f"{name} is not pinned in tools/vectors/requirements.txt")
        try:
            installed = metadata.version(name)
        except metadata.PackageNotFoundError:
            fail(f"{name} is not installed (pip install --require-hashes -r {REQUIREMENTS.relative_to(ROOT)})")
        if installed != pinned:
            fail(f"{name} {installed} is installed but {pinned} is pinned")
        parts.append(f"{name} {installed}")
    return "python (" + ", ".join(parts) + ")"


def read_source(name, sha256_hex):
    """A committed copy of a published vector file, verified against the digest recorded in the
    generator (which is also the digest of the upstream file at the pinned commit)."""
    data = (SOURCES / name).read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    if digest != sha256_hex:
        fail(f"tools/vectors/sources/{name} has SHA-256 {digest}, expected {sha256_hex}")
    return data


def committed_cases(suite):
    path = ROOT / "test-vectors" / suite / "vectors.json"
    if not path.exists():
        fail(f"{path.relative_to(ROOT)} is missing; it holds the published secret values")
    return {c["id"]: c for c in json.loads(path.read_text(encoding="utf-8"))["cases"]}


def read_redacted_source(name, suite, upstream_sha256):
    """A published vector file whose key material is kept only in the committed vectors.json.

    tools/vectors/sources/<name> is the upstream file with every secret value replaced by a token
    `@<case id>/<input|expected>/<field>[/upper]`. The tokens are filled from the committed
    test-vectors/<suite>/vectors.json and the result must hash to the upstream file's published
    SHA-256, so the committed secrets are exactly the published ones and nothing else is."""
    text = (SOURCES / name).read_bytes().decode("utf-8")  # bytes: keep CRLF line ends exactly
    cases = committed_cases(suite)

    def fill(match):
        case_id, part, field, upper = match.group(1), match.group(2), match.group(3), match.group(4)
        try:
            value = cases[case_id][part][field]
        except KeyError:
            fail(f"{name}: token {match.group(0)} has no value in test-vectors/{suite}/vectors.json")
        return value.upper() if upper else value

    restored = re.sub(r"@([a-z0-9-]+)/(input|expected)/([A-Za-z0-9]+)(/upper)?", fill, text)
    digest = hashlib.sha256(restored.encode("utf-8")).hexdigest()
    if digest != upstream_sha256:
        fail(f"{name} with the committed secrets has SHA-256 {digest}, the upstream file {upstream_sha256}")
    return restored.encode("utf-8")


def committed_inputs(suite):
    """Case id -> input of the committed test-vectors/<suite>/vectors.json.

    Key material of published vectors is kept only in committed vectors.json files, the one place
    the secret scan allowlists. Generators read it back from there and check it against published
    values: the upstream file's SHA-256 (read_redacted_source) or published public outputs (the
    CFRG HPKE keys against pkEm, enc and the ciphertexts), so a changed value still fails --check."""
    return {case_id: c["input"] for case_id, c in committed_cases(suite).items()}


# --- encodings -----------------------------------------------------------------------------------


def hx(data):
    return bytes(data).hex()


def unhex(text):
    return bytes.fromhex(text)


def b64u(data):
    return base64.urlsafe_b64encode(bytes(data)).rstrip(b"=").decode("ascii")


def unb64u(text):
    """Strict base64url without padding (04 §3.1): no padding, no '+'/'/', zero trailing bits."""
    if not re.fullmatch(r"[A-Za-z0-9_-]*", text) or len(text) % 4 == 1:
        raise ValueError("not canonical base64url")
    data = base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))
    if b64u(data) != text:
        raise ValueError("not canonical base64url")
    return data


def u8(n):
    return int(n).to_bytes(1, "big")


def u16be(n):
    return int(n).to_bytes(2, "big")


def u32be(n):
    return int(n).to_bytes(4, "big")


# --- deterministic test inputs -------------------------------------------------------------------


def det(label, length):
    """Deterministic, obviously synthetic test bytes: SHA-256 in counter mode over a fixed prefix
    and a label. Used for test seeds, keys, nonces and IVs so every value is reproducible and none
    is a real secret."""
    out = b""
    counter = 0
    while len(out) < length:
        out += hashlib.sha256(f"agentlink-test-vectors/v1/{label}/{counter}".encode()).digest()
        counter += 1
    return out[:length]


# --- hashes, MACs and KDFs -----------------------------------------------------------------------


def sha256(data):
    return hashlib.sha256(bytes(data)).digest()


def hmac_sha256(key, data):
    return _hmac.new(bytes(key), bytes(data), hashlib.sha256).digest()


def hkdf_sha256(ikm, salt, info, length):
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF

    return HKDF(algorithm=hashes.SHA256(), length=length, salt=bytes(salt), info=bytes(info)).derive(
        bytes(ikm)
    )


def hkdf_sha256_written_out(ikm, salt, info, length):
    """RFC 5869 Extract and Expand written out over hashlib HMAC, only to cross-check
    `hkdf_sha256` (`cryptography`). An empty salt is HashLen zero bytes (RFC 5869 §2.2); HMAC pads
    both to the same block, so they give the same PRK."""
    prk = hmac_sha256(bytes(salt) if salt else bytes(32), bytes(ikm))
    out, block, counter = b"", b"", 1
    while len(out) < length:
        block = hmac_sha256(prk, block + bytes(info) + bytes([counter]))
        out += block
        counter += 1
    return out[:length]


# 04 §3.3 (G-46, D-66): the only derivations that take the CEK as ikm.
PAYLOAD_KEY_LABEL = "agentlink/v1/payload-key"
PAYLOAD_COMMIT_LABEL = "agentlink/v1/payload-commit"
CEK_EPH_LABEL = "agentlink/v1/cek-eph"
CEK_DERIVATION_LABELS = (PAYLOAD_KEY_LABEL, PAYLOAD_COMMIT_LABEL, CEK_EPH_LABEL)


def derive_from_cek(label, cek, envelope_id, recipient_public=None):
    """04 §3.3 derivations from the CEK: HKDF-SHA256, ikm = CEK (32 bytes), empty salt, 32-byte
    output; info = utf8(label) || id (16 raw bytes), and || pk_j (the raw 32-byte X25519 key) for
    `agentlink/v1/cek-eph` only. Raises ValueError for any other label or length."""
    if label not in CEK_DERIVATION_LABELS:
        raise ValueError("not a CEK derivation label")
    if len(cek) != 32 or len(envelope_id) != 16:
        raise ValueError("wrong CEK or id length")
    suffix = b""
    if label == CEK_EPH_LABEL:
        if recipient_public is None or len(recipient_public) != 32:
            raise ValueError("cek-eph needs a 32-byte recipient key")
        suffix = bytes(recipient_public)
    elif recipient_public is not None:
        raise ValueError("only cek-eph takes a recipient key")
    info = label.encode("utf-8") + bytes(envelope_id) + suffix
    out = hkdf_sha256(cek, b"", info, 32)
    if out != hkdf_sha256_written_out(cek, b"", info, 32):
        fail("cryptography's HKDF disagrees with RFC 5869 written out")
    return out


def tagged_hash(tag, message):
    """BIP-340 tagged hash: SHA256(SHA256(tag) || SHA256(tag) || msg)."""
    tag_hash = sha256(tag.encode("utf-8"))
    return sha256(tag_hash + tag_hash + bytes(message))


def keccak256(data):
    from Crypto.Hash import keccak

    return keccak.new(digest_bits=256, data=bytes(data)).digest()


def jcs(value):
    """RFC 8785 canonical UTF-8 bytes (Trail of Bits `rfc8785`)."""
    import rfc8785

    return rfc8785.dumps(value)


def escaped_member_name(text):
    """True when JSON `text` writes any object member name with an escape sequence (04 §2.5.1
    "Received text", D-128). A token scan of the raw text, independent of any JSON library: a string
    is a member name exactly when the next non-whitespace character after it is a colon."""
    i, n = 0, len(text)
    while i < n:
        if text[i] != '"':
            i += 1
            continue
        j, escaped = i + 1, False
        while j < n and text[j] != '"':
            if text[j] == "\\":
                escaped = True
                j += 1
            j += 1
        k = j + 1
        while k < n and text[k] in " \t\n\r":
            k += 1
        if escaped and k < n and text[k] == ":":
            return True
        i = j + 1
    return False


def parse_received_text(text):
    """The 04 §2.5.1 "Received text" parse (D-128): refuses an escaped member name, a duplicate
    member name at any depth (RFC 7493 §2.3) and any number token other than 0|[1-9][0-9]* up to
    2^53 - 1 (04 §2.4.1). Raises ValueError on refusal; returns the parsed value."""
    if escaped_member_name(text):
        raise ValueError("escaped member name")

    def pairs(items):
        names = [k for k, _ in items]
        if len(set(names)) != len(names):
            raise ValueError("duplicate member name")
        return dict(items)

    def integer(token):
        if not re.fullmatch(r"0|[1-9][0-9]*", token) or int(token) > 2**53 - 1:
            raise ValueError("non-canonical integer token")
        return int(token)

    def no_float(token):
        raise ValueError("non-integer number token")

    return json.loads(text, object_pairs_hook=pairs, parse_int=integer, parse_float=no_float, parse_constant=no_float)


def jcs_lenient(value):
    """JCS for objects that deliberately break the integer rules. `rfc8785` refuses integers beyond
    2^53 - 1; RFC 8785 serialises numbers as IEEE 754 doubles, which is what a JavaScript verifier
    sees, so such integers are canonicalised as doubles here."""

    def fix(x):
        if isinstance(x, bool):
            return x
        if isinstance(x, int):
            return float(x) if abs(x) > 2**53 - 1 else x
        if isinstance(x, dict):
            return {k: fix(val) for k, val in x.items()}
        if isinstance(x, list):
            return [fix(val) for val in x]
        return x

    return jcs(fix(value))


def argon2id(password, salt, m_kib, t, p, length=32, secret=None, ad=None):
    from cryptography.hazmat.primitives.kdf.argon2 import Argon2id

    kwargs = {}
    if secret is not None:
        kwargs["secret"] = bytes(secret)
    if ad is not None:
        kwargs["ad"] = bytes(ad)
    return Argon2id(
        salt=bytes(salt), length=length, iterations=t, lanes=p, memory_cost=m_kib, **kwargs
    ).derive(bytes(password))


def aes256gcm_encrypt(key, iv, plaintext, aad):
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    return AESGCM(bytes(key)).encrypt(bytes(iv), bytes(plaintext), bytes(aad))


def aes256gcm_decrypt(key, iv, ciphertext, aad):
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    return AESGCM(bytes(key)).decrypt(bytes(iv), bytes(ciphertext), bytes(aad))


# --- secp256k1 and X25519 ------------------------------------------------------------------------

SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141


def xonly_public_key(secret_key):
    from coincurve import PrivateKey

    return PrivateKey(bytes(secret_key)).public_key.format(compressed=True)[1:]


def schnorr_sign(secret_key, message32, aux_rand):
    from coincurve import PrivateKey

    if len(message32) != 32:
        fail("coincurve signs 32-byte messages only")
    return PrivateKey(bytes(secret_key)).sign_schnorr(bytes(message32), bytes(aux_rand))


def schnorr_verify(public_key, message32, signature):
    from coincurve import PublicKeyXOnly

    try:
        return PublicKeyXOnly(bytes(public_key)).verify(bytes(signature), bytes(message32))
    except Exception:  # invalid public key encoding or point not on the curve
        return False


def evm_address(secret_key):
    """Lowercase 0x address: keccak256(uncompressed public key without 0x04)[12:]."""
    from coincurve import PrivateKey

    public = PrivateKey(bytes(secret_key)).public_key.format(compressed=False)[1:]
    return "0x" + keccak256(public)[12:].hex()


def eip55(address):
    """EIP-55 mixed-case checksum encoding of a 0x address."""
    lower = address[2:].lower()
    digest = keccak256(lower.encode("ascii")).hex()
    return "0x" + "".join(c.upper() if int(d, 16) >= 8 else c for c, d in zip(lower, digest))


# EIP-55 (ethereum/ERCs ERCS/erc-55.md, "Test Cases"): every published example must round-trip.
_EIP55_PUBLISHED = [
    "0x52908400098527886E0F7030069857D2E4169EE7",
    "0x8617E340B3D01FA5F11F306F4090FD50E238070D",
    "0xde709f2102306220921060314715629080e2fb77",
    "0x27b1fdb04752bbc536007a920d24acb045561c26",
    "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
    "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
    "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB",
    "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb",
]


def check_eip55():
    for published in _EIP55_PUBLISHED:
        if eip55(published) != published:
            fail(f"EIP-55 encoding of {published} disagrees with the published value")


def x25519_public_key(secret_key):
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey

    return (
        X25519PrivateKey.from_private_bytes(bytes(secret_key))
        .public_key()
        .public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    )




# --- case schema helpers -------------------------------------------------------------------------

HEX = {"type": "string", "pattern": "^([0-9a-f]{2})*$"}
B64U = {"type": "string", "pattern": "^[A-Za-z0-9_-]*$"}
STRING = {"type": "string"}
INTEGER = {"type": "integer"}
OBJECT = {"type": "object"}
ARRAY = {"type": "array"}
ANY = {}
ADDRESS = {"type": "string", "pattern": "^0x[0-9a-f]{40}$"}
CHECKSUM_ADDRESS = {"type": "string", "pattern": "^0x[0-9a-fA-F]{40}$"}
ACCEPT = {"outcome": {"const": "accept"}}
REJECT = {"outcome": {"const": "reject"}}


def hexn(n):
    return {"type": "string", "pattern": f"^[0-9a-f]{{{2 * n}}}$"}


def strict_object(fields):
    return {
        "type": "object",
        "additionalProperties": False,
        "required": list(fields),
        "properties": dict(fields),
    }


def case_schema(suite, description, ops):
    """`ops` maps each op name to (input fields, [expected alternatives]); every alternative is a
    dict of expected fields. A case must match exactly one op."""
    branches = []
    for op, (inputs, alternatives) in ops.items():
        fields = {"op": {"const": op}, **inputs}
        expected = [strict_object(alt) for alt in alternatives]
        branches.append(
            {
                "type": "object",
                "properties": {
                    "input": strict_object(fields),
                    "expected": expected[0] if len(expected) == 1 else {"oneOf": expected},
                },
            }
        )
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": f"https://github.com/4thtech/agentlink/test-vectors/{suite}/case.schema.json",
        "title": f"{suite} case",
        "description": description,
        "type": "object",
        "additionalProperties": False,
        "required": ["id", "source", "input", "expected"],
        "properties": {
            "id": {"type": "string"},
            "source": {"type": "string"},
            "input": {"type": "object"},
            "expected": {"type": "object"},
        },
        "oneOf": branches,
    }


def optional_input(schema, op, field):
    """Make one input field of `op` optional in a schema from case_schema (a case that tests the
    field's absence)."""
    for branch in schema["oneOf"]:
        inputs = branch["properties"]["input"]
        if inputs["properties"]["op"] == {"const": op}:
            inputs["required"] = [name for name in inputs["required"] if name != field]
            return schema
    fail(f"{schema['title']}: no op {op}")


# --- write / check -------------------------------------------------------------------------------


def case(case_id, source, input_, expected):
    return {"id": case_id, "source": source, "input": input_, "expected": expected}


def render(document):
    return json.dumps(document, indent=2, ensure_ascii=True) + "\n"


def main(*, suite, version, script, libraries, build, schema, doc, runtimes=None):
    """`runtimes`: optional (list, spec source) when a spec runtime table limits the suite (e.g. the
    file KeyStore is Node only, 04 §2.8); the harness then requires exactly those runtimes."""
    parser = argparse.ArgumentParser(description=doc.strip().splitlines()[0])
    mode = parser.add_mutually_exclusive_group(required=True)
    out = ROOT / "test-vectors" / suite / "vectors.json"
    schema_path = out.with_name("case.schema.json")
    mode.add_argument("--check", nargs="?", const=str(out), metavar="FILE")
    mode.add_argument("--write", action="store_true")
    args = parser.parse_args()

    cases = build()
    ids = [c["id"] for c in cases]
    if len(set(ids)) != len(ids):
        fail(f"{suite}: duplicate case ids")
    for case_id in ids:
        if not ID_PATTERN.match(case_id):
            fail(f"{suite}: bad case id {case_id!r}")
    for c in cases:
        for field, value in c["expected"].items():
            if not isinstance(value, str) or value == "":
                fail(f"{suite}/{c['id']}: expected.{field} must be a non-empty string")

    document = {
        "$schema": "../schema/vector-file.schema.json",
        "suite": suite,
        "version": version,
        "generator": {
            "tool": tool_string(libraries),
            "version": "cpython " + platform.python_version(),
            "script": script,
        },
        "cases": cases,
    }
    if runtimes is not None:
        only, source = runtimes
        if not only or not set(only) <= {"node", "chromium", "firefox", "webkit", "workerd"} or not source:
            fail(f"{suite}: runtimes must name known runtimes and cite a spec source")
        cases_value = document.pop("cases")
        document["runtimes"] = {"only": list(only), "source": source}
        document["cases"] = cases_value
    schema_text = json.dumps(schema, indent=2, ensure_ascii=True) + "\n"

    if args.write:
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(render(document), encoding="utf-8")
        schema_path.write_text(schema_text, encoding="utf-8")
        print(f"wrote {out.relative_to(ROOT)} ({len(cases)} cases) and {schema_path.name}")
        return

    target = Path(args.check)
    committed_text = target.read_text(encoding="utf-8")
    try:
        committed_version = json.loads(committed_text)["generator"]["version"]
    except (ValueError, KeyError, TypeError):
        sys.exit(f"{target}: not a vector file")
    # Only the Python version of the machine that wrote the file may differ (generate_sha256.py).
    document["generator"]["version"] = committed_version
    if committed_text != render(document):
        mismatch(target, committed_text, render(document))
    if target.resolve() == out.resolve():
        if schema_path.read_text(encoding="utf-8") != schema_text:
            print(f"{schema_path} differs from the generator output", file=sys.stderr)
            sys.exit(MISMATCH)
    print(f"{target}: matches the generator output ({len(cases)} cases)")
