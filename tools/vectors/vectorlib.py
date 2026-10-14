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


# RFC 7748 section 6.1 (Alice's key pair).
_RFC7748_ALICE = (
    "77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a",
    "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a",
)


def check_x25519():
    if x25519_public_key(unhex(_RFC7748_ALICE[0])).hex() != _RFC7748_ALICE[1]:
        fail("X25519 public key disagrees with RFC 7748 section 6.1")


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


# --- write / check -------------------------------------------------------------------------------


def case(case_id, source, input_, expected):
    return {"id": case_id, "source": source, "input": input_, "expected": expected}


def render(document):
    return json.dumps(document, indent=2, ensure_ascii=True) + "\n"


def main(*, suite, version, script, libraries, build, schema, doc):
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
        sys.exit(f"{target} differs from the generator output")
    if target.resolve() == out.resolve():
        if schema_path.read_text(encoding="utf-8") != schema_text:
            sys.exit(f"{schema_path} differs from the generator output")
    print(f"{target}: matches the generator output ({len(cases)} cases)")
