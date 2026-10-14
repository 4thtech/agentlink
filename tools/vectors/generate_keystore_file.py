#!/usr/bin/env python3
"""Independent generator for the `keystore-file` suite: the headless file KeyStore ALKS v1 (M1-1h).

04 §2.8 (D-54), exactly:
  header = "ALKS" | u8 version=1 | u8 secretKind | u8 kdf=1 | u32be m (KiB) | u8 t | u8 p |
           salt (16) | u8 aead=1 | nonce (12) | u8 idLen (1..64) | agentId ([A-Za-z0-9_-])
  kek    = HKDF-SHA256(ikm = Argon2id(normalise(secret, secretKind), salt, m, t, p, L = 32),
                       salt = "", info = utf8("agentlink/v1/keystore-file"), L = 32)
  file   = header || AES-256-GCM(kek, nonce, plaintext, AAD = header)   (ciphertext || 16-byte tag)
  plaintext = entries `u16be nameLen | name (UTF-8) | u32be valueLen | value`
Argon2id (v1.3), HKDF and AES-GCM are `cryptography` (Argon2id checked against RFC 9106 in the
`owner-wrap` suite, HKDF against RFC 5869 in `hkdf-derive`). Passphrases, salts, nonces and entry
values are synthetic test values.

File vectors use secretKind 2 (chosen passphrase: UTF-8 of Unicode NFKC, otherwise unchanged).
For secretKind 1 (generated code) only the normalisation is covered: the spec does not say
whether Argon2id then receives the 24 canonical characters or the 15 decoded bytes (question in
the M1-1h PR). The second, seed-derived agent-ID check after decryption needs `agentId` (G-23)
and is not covered.

Rejections (04 §2.8 "Required tests"): wrong passphrase; a flipped byte in every header field, the
ciphertext and the tag; truncation; unknown version, kdf, aead and secretKind; KDF parameters
outside the floor and cap (sealed validly, so only the bounds check can refuse them); idLen 0 or
above 64 and an invalid agentId charset; another agent's file (same passphrase); duplicate entry
names, length overflows, trailing bytes and plaintext above 64 KiB (all sealed validly).

Usage: python3 -I tools/vectors/generate_keystore_file.py --check [FILE] | --write
"""

import base64
import re
import sys
import unicodedata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import vectorlib as v  # noqa: E402

SUITE = "keystore-file"
VERSION = 1
SPEC = "04 §2.8 ALKS v1"
INFO = b"agentlink/v1/keystore-file"
FLOOR = (19456, 2, 1)
DEFAULT = (65536, 3, 1)
BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"


# --- reference implementation of the format ------------------------------------------------------


def normalise(secret, kind):
    if kind == 1:
        code = secret.upper().replace(" ", "").replace("-", "")
        code = code.replace("0", "O").replace("1", "I").replace("8", "B")
        if len(code) != 24 or any(c not in BASE32 for c in code):
            raise ValueError("not a 24-character code")
        return code
    if kind == 2:
        return unicodedata.normalize("NFKC", secret)
    raise ValueError("unknown secretKind")


def kek(secret, kind, salt, m, t, p):
    if kind != 2:
        v.fail("file vectors use secretKind 2 only")
    ikm = v.argon2id(normalise(secret, kind).encode("utf-8"), salt, m, t, p, 32)
    return v.hkdf_sha256(ikm, b"", INFO, 32)


def header(kind, m, t, p, salt, nonce, agent_id, version=1, kdf=1, aead=1, id_len=None):
    raw_id = agent_id.encode("utf-8")
    return (
        b"ALKS" + v.u8(version) + v.u8(kind) + v.u8(kdf) + v.u32be(m) + v.u8(t) + v.u8(p)
        + salt + v.u8(aead) + nonce + v.u8(len(raw_id) if id_len is None else id_len) + raw_id
    )


def entries_bytes(entries):
    out = b""
    for name, value in entries:
        raw = name.encode("utf-8")
        out += v.u16be(len(raw)) + raw + v.u32be(len(value)) + value
    return out


def seal(secret, kind, m, t, p, salt, nonce, agent_id, plaintext, **header_overrides):
    h = header(kind, m, t, p, salt, nonce, agent_id, **header_overrides)
    return h + v.aes256gcm_encrypt(kek(secret, kind, salt, m, t, p), nonce, plaintext, h)


def parse_entries(plaintext):
    if len(plaintext) > 65536:
        raise ValueError("plaintext above 64 KiB")
    entries, i = [], 0
    while i < len(plaintext):
        if i + 2 > len(plaintext):
            raise ValueError("trailing bytes")
        n = int.from_bytes(plaintext[i : i + 2], "big")
        i += 2
        if i + n + 4 > len(plaintext):
            raise ValueError("name length overflow")
        name = plaintext[i : i + n].decode("utf-8")
        i += n
        size = int.from_bytes(plaintext[i : i + 4], "big")
        i += 4
        if i + size > len(plaintext):
            raise ValueError("value length overflow")
        if name in dict(entries):
            raise ValueError("duplicate name")
        entries.append((name, plaintext[i : i + size]))
        i += size
    return entries


def open_file(data, secret, expected_agent_id):
    """Every refusal of 04 §2.8 that applies without an agentId derivation (G-23)."""
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", expected_agent_id):
        raise ValueError("invalid expected agentId")
    if len(data) < 60 or data[:4] != b"ALKS" or data[4] != 1 or data[6] != 1 or data[29] != 1:
        raise ValueError("bad header")
    kind = data[5]
    m = int.from_bytes(data[7:11], "big")
    t, p = data[11], data[12]
    salt, nonce = data[13:29], data[30:42]
    if kind not in (1, 2):
        raise ValueError("unknown secretKind")
    if m < 19456 or m > 262144 or t < 2 or t > 8 or p < 1 or p > 4:
        raise ValueError("KDF parameters out of bounds")
    id_len = data[42]
    if not 1 <= id_len <= 64 or len(data) < 43 + id_len + 16:
        raise ValueError("bad idLen")
    agent_id = data[43 : 43 + id_len].decode("ascii", "replace")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", agent_id) or agent_id != expected_agent_id:
        raise ValueError("agentId mismatch")
    h = data[: 43 + id_len]
    norm = normalise(secret, kind)  # refuses before the KDF runs
    ikm = v.argon2id(norm.encode("utf-8"), salt, m, t, p, 32)
    plaintext = v.aes256gcm_decrypt(v.hkdf_sha256(ikm, b"", INFO, 32), nonce, data[len(h) :], h)
    return parse_entries(plaintext)


def refused(*args):
    try:
        open_file(*args)
    except Exception:
        return True
    return False


# --- cases ---------------------------------------------------------------------------------------


def build():
    cases = []
    passphrase = "correct horse battery staple"
    unicode_passphrase = "Ｐａｓｓ ﬁle Café ✓ keystore"
    seed = v.det("keystore-file/seed", 32)
    store_key = v.det("keystore-file/store-key", 32)
    s3 = b'{"accessKeyId":"TESTONLY","secret":"' + base64.b64encode(v.det("keystore-file/s3", 30)) + b'"}'
    entries1 = [("seed", seed), ("store-key", store_key)]
    entries2 = [("seed", seed), ("store-key", store_key), ("s3:primary", s3)]

    def entry_fields(entries):
        out = {"entryNames": ",".join(name for name, _ in entries)}
        out.update({f"entry:{name}": v.hx(value) for name, value in entries})
        return out

    files = {}

    def file_case(case_id, why, secret, params, agent_id, entries, salt_label, nonce_label):
        salt, nonce = v.det(f"keystore-file/{salt_label}", 16), v.det(f"keystore-file/{nonce_label}", 12)
        data = seal(secret, 2, *params, salt, nonce, agent_id, entries_bytes(entries))
        if open_file(data, secret, agent_id) != entries:
            v.fail(f"{case_id} does not open")
        files[case_id] = data
        m, t, p = params
        common = {"secretKind": 2, "secret": secret, "salt": v.hx(salt), "memoryKiB": m, "iterations": t, "parallelism": p}
        cases.append(v.case(f"kek-{case_id}", f"{SPEC} kek ({why})", {"op": "kek", **common}, {"kek": v.hx(kek(secret, 2, salt, *params))}))
        cases.append(
            v.case(
                f"seal-{case_id}",
                f"{SPEC} seal ({why})",
                {"op": "seal", **common, "nonce": v.hx(nonce), "agentId": agent_id, "entries": [{"name": n, "value": v.hx(val)} for n, val in entries]},
                {"file": v.hx(data)},
            )
        )
        cases.append(v.case(f"open-{case_id}", f"{SPEC} open ({why})", {"op": "open", "file": v.hx(data), "secret": secret, "expectedAgentId": agent_id}, entry_fields(entries)))
        return data

    f1 = file_case("floor", "KDF floor m = 19 MiB, t = 2, p = 1", passphrase, FLOOR, "agent_01", entries1, "salt-1", "nonce-1")
    file_case("default", "default m = 64 MiB, t = 3, p = 1; storage credential entry", unicode_passphrase, DEFAULT, "Agent-XYZ_123", entries2, "salt-2", "nonce-2")
    cases.append(
        v.case(
            "open-default-nfkc-equivalent",
            f"{SPEC} open with the NFKC-equivalent spelling of the passphrase (normalisation applies)",
            {"op": "open", "file": v.hx(files["default"]), "secret": unicodedata.normalize("NFKC", unicode_passphrase), "expectedAgentId": "Agent-XYZ_123"},
            entry_fields(entries2),
        )
    )
    other_agent = file_case("other-agent", "a second agent with the same passphrase", passphrase, FLOOR, "agent_02", entries1, "salt-3", "nonce-3")

    # 64 KiB boundary: exactly 65536 bytes of plaintext opens; one more byte is refused.
    big_value = v.det("keystore-file/blob", 65536 - 2 - 4 - 4)
    big = [("blob", big_value)]
    if len(entries_bytes(big)) != 65536:
        v.fail("boundary plaintext is not 64 KiB")
    salt1, nonce1 = v.det("keystore-file/salt-1", 16), v.det("keystore-file/nonce-1", 12)
    big_file = seal(passphrase, 2, *FLOOR, salt1, nonce1, "agent_01", entries_bytes(big))
    if open_file(big_file, passphrase, "agent_01") != big:
        v.fail("64 KiB plaintext does not open")
    cases.append(v.case("open-plaintext-64-kib", f"{SPEC}: plaintext of exactly 64 KiB is accepted", {"op": "open", "file": v.hx(big_file), "secret": passphrase, "expectedAgentId": "agent_01"}, entry_fields(big)))

    def reject(case_id, why, data, secret=passphrase, expected="agent_01"):
        if not refused(data, secret, expected):
            v.fail(f"{case_id} opens")
        cases.append(v.case(case_id, f"{SPEC}: {why}", {"op": "open", "file": v.hx(data), "secret": secret, "expectedAgentId": expected}, {"outcome": "reject"}))

    def flipped(data, offset, mask=0x01):
        out = bytearray(data)
        out[offset] ^= mask
        return bytes(out)

    reject("open-reject-wrong-passphrase", "wrong passphrase", f1, secret="correct horse battery stapler")
    reject("open-reject-passphrase-trailing-newline", "a trailing newline is part of the passphrase (only a passphrase file loses one)", f1, secret=passphrase + "\n")
    for field, offset in [
        ("magic", 0), ("version", 4), ("secret-kind", 5), ("kdf", 6), ("memory", 10), ("iterations", 11),
        ("parallelism", 12), ("salt", 13), ("aead", 29), ("nonce", 30), ("id-len", 42), ("agent-id", 43),
    ]:
        reject(f"open-reject-flip-{field}", f"header byte flipped ({field})", flipped(f1, offset))
    header_len = 43 + len("agent_01")
    reject("open-reject-flip-ciphertext", "ciphertext byte flipped", flipped(f1, header_len))
    reject("open-reject-flip-tag", "tag byte flipped", flipped(f1, len(f1) - 1))
    reject("open-reject-truncated-tag", "file truncated by one byte", f1[:-1])
    reject("open-reject-truncated-to-header", "file truncated to its header", f1[:header_len])
    reject("open-reject-truncated-in-header", "file truncated inside the header", f1[:20])
    reject("open-reject-empty", "empty file", b"")

    salt, nonce = salt1, nonce1
    plain1 = entries_bytes(entries1)

    def sealed(**overrides):
        params = dict(m=FLOOR[0], t=FLOOR[1], p=FLOOR[2], kind=2, agent_id="agent_01", plaintext=plain1)
        params.update(overrides)
        header_args = {k: params.pop(k) for k in ["version", "kdf", "aead", "id_len"] if k in params}
        return seal(passphrase, params["kind"], params["m"], params["t"], params["p"], salt, nonce, params["agent_id"], params["plaintext"], **header_args)

    def crafted(**fields):
        """A header with values the format forbids, sealed under the otherwise valid kek."""
        h = header(2, FLOOR[0], FLOOR[1], FLOOR[2], salt, nonce, "agent_01", **fields)
        return h + v.aes256gcm_encrypt(kek(passphrase, 2, salt, *FLOOR), nonce, plain1, h)

    reject("open-reject-version-2", "unknown version", crafted(version=2))
    reject("open-reject-kdf-2", "unknown kdf", crafted(kdf=2))
    reject("open-reject-aead-2", "unknown aead", crafted(aead=2))
    for kind in (0, 3):
        h = header(kind, *FLOOR, salt, nonce, "agent_01")
        reject(f"open-reject-secret-kind-{kind}", "unknown secretKind", h + v.aes256gcm_encrypt(kek(passphrase, 2, salt, *FLOOR), nonce, plain1, h))
    for case_id, why, m, t, p in [
        ("memory-below-floor", "m below 19 MiB", 19455, 2, 1),
        ("iterations-below-floor", "t below 2", 19456, 1, 1),
        ("memory-above-cap", "m above 256 MiB", 262145, 2, 1),
        ("iterations-above-cap", "t above 8", 19456, 9, 1),
        ("parallelism-above-cap", "p above 4", 19456, 2, 5),
    ]:
        reject(f"open-reject-{case_id}", f"KDF parameters out of bounds ({why}), refused before the KDF runs", sealed(m=m, t=t, p=p))
    h = header(2, FLOOR[0], FLOOR[1], 0, salt, nonce, "agent_01")
    reject("open-reject-parallelism-zero", "KDF parameters out of bounds (p = 0), refused before the KDF runs", h + bytes(len(plain1) + 16))
    reject("open-reject-id-len-zero", "idLen = 0 (no agentId)", sealed(agent_id=""))
    long_id = "a" * 65
    reject("open-reject-id-len-65", "idLen above 64", sealed(agent_id=long_id), expected="a" * 64)
    reject("open-reject-agent-id-charset", "agentId outside [A-Za-z0-9_-]", sealed(agent_id="agent.01"), expected="agent_01")
    reject("open-reject-other-agent", "another agent's file with the same passphrase (header agentId differs)", other_agent)
    reject("open-reject-expected-id-mismatch", "the file's agentId differs from the agent being opened", f1, expected="agent_02")

    dup = entries_bytes([("seed", seed), ("seed", store_key)])
    reject("open-reject-duplicate-entry", "duplicate entry names", sealed(plaintext=dup))
    reject("open-reject-name-length-overflow", "entry name length past the end", sealed(plaintext=v.u16be(200) + b"seed"))
    reject("open-reject-value-length-overflow", "entry value length past the end", sealed(plaintext=v.u16be(4) + b"seed" + v.u32be(33) + seed))
    reject("open-reject-trailing-byte", "trailing bytes after the last entry", sealed(plaintext=plain1 + b"\x00"))
    too_big = [("blob", v.det("keystore-file/blob", 65536 - 2 - 4 - 4 + 1))]
    reject("open-reject-plaintext-above-64-kib", "plaintext above 64 KiB", sealed(plaintext=entries_bytes(too_big)))

    # secretKind 1 normalisation (generated code): case-insensitive; spaces and dashes removed;
    # 0, 1 and 8 read as O, I and B; anything but 24 base32 characters refused before the KDF.
    canonical = "OBIA7Q2MKXW4RT5ZLDNE3H6C"
    for case_id, raw in [
        ("canonical", canonical),
        ("lowercase-dashes", "obia-7q2m-kxw4-rt5z-ldne-3h6c"),
        ("groups-of-four", "OBIA 7Q2M KXW4 RT5Z LDNE 3H6C"),
        ("digits-for-letters", "0B1A 7Q2M KXW4 RT5Z LDNE 3H6C"),
        ("eight-for-b", "o8ia7q2mkxw4rt5zldne3h6c"),
    ]:
        if normalise(raw, 1) != canonical:
            v.fail(f"normalisation of {raw}")
        cases.append(v.case(f"normalise-code-{case_id}", f"{SPEC} generated-code normalisation", {"op": "normalise", "secretKind": 1, "secret": raw}, {"normalised": canonical}))
    for case_id, raw in [
        ("23-chars", canonical[:-1]),
        ("25-chars", canonical + "A"),
        ("digit-9", canonical[:-1] + "9"),
        ("padding", canonical[:-1] + "="),
        ("dot-separator", "OBIA.7Q2M.KXW4.RT5Z.LDNE.3H6C"),
        ("non-ascii", canonical[:-1] + "Ä"),
    ]:
        try:
            normalise(raw, 1)
            v.fail(f"code {raw} accepted")
        except ValueError:
            pass
        cases.append(v.case(f"normalise-code-reject-{case_id}", f"{SPEC}: anything other than 24 valid characters is refused before the KDF", {"op": "normalise", "secretKind": 1, "secret": raw}, {"outcome": "reject"}))
    for case_id, raw in [
        ("ascii", passphrase),
        ("fullwidth-and-ligature", unicode_passphrase),
        ("spaces-kept", "  two  spaces  inside  "),
        ("combining-accent", "Café passphrase"),
    ]:
        cases.append(v.case(f"normalise-passphrase-{case_id}", f"{SPEC} chosen passphrase: Unicode NFKC, otherwise unchanged", {"op": "normalise", "secretKind": 2, "secret": raw}, {"normalised": normalise(raw, 2)}))
    return cases


ENTRY = v.strict_object({"name": v.STRING, "value": v.HEX})
OPEN_OK = {"type": "object", "required": ["entryNames"], "properties": {"entryNames": v.STRING}, "patternProperties": {"^entry:": v.HEX}, "additionalProperties": False}
SCHEMA = v.case_schema(
    SUITE,
    "04 §2.8 ALKS v1. `kek`: key-encryption key. `seal`: the whole file as hex. `open`: entry "
    "names (comma-separated, in file order) and each value as `entry:<name>` hex, or a rejection. "
    "`normalise`: the normalised secret for its secretKind, or a rejection.",
    {
        "kek": (
            {"secretKind": v.INTEGER, "secret": v.STRING, "salt": v.hexn(16), "memoryKiB": v.INTEGER, "iterations": v.INTEGER, "parallelism": v.INTEGER},
            [{"kek": v.hexn(32)}],
        ),
        "seal": (
            {
                "secretKind": v.INTEGER,
                "secret": v.STRING,
                "salt": v.hexn(16),
                "memoryKiB": v.INTEGER,
                "iterations": v.INTEGER,
                "parallelism": v.INTEGER,
                "nonce": v.hexn(12),
                "agentId": v.STRING,
                "entries": {"type": "array", "items": ENTRY},
            },
            [{"file": v.HEX}],
        ),
        "open": ({"file": v.HEX, "secret": v.STRING, "expectedAgentId": v.STRING}, [v.REJECT]),
        "normalise": ({"secretKind": v.INTEGER, "secret": v.STRING}, [{"normalised": v.STRING}, v.REJECT]),
    },
)
# `open` succeeds with a variable set of entry fields, which strict_object cannot express.
SCHEMA["oneOf"][2]["properties"]["expected"] = {"oneOf": [OPEN_OK, v.strict_object(v.REJECT)]}

if __name__ == "__main__":
    v.main(
        suite=SUITE,
        version=VERSION,
        script="tools/vectors/generate_keystore_file.py",
        libraries=["cryptography"],
        build=build,
        schema=SCHEMA,
        doc=__doc__,
    )
