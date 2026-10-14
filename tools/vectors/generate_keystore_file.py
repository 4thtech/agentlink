#!/usr/bin/env python3
"""Independent generator for the `keystore-file` suite: ALKS v1 and ALKO v1 (M1-1h).

04 §2.8 (D-54), exactly:
  ALKS header = "ALKS" | u8 version=1 | u8 secretKind | u8 kdf=1 | u32be m (KiB) | u8 t | u8 p |
                salt (16) | u8 aead=1 | nonce (12) | u8 idLen (1..64) | agentId ([A-Za-z0-9_-])
  ALKO header = "ALKO" | u8 version=1 | u8 secretKind | u8 kdf=1 | u32be m | u8 t | u8 p |
                salt (16) | u8 aead=1 | nonce (12)                       (42 bytes; blob 90 bytes)
  kek  = HKDF-SHA256(ikm = Argon2id(password(secret, kind), salt, m, t, p, L = 32), salt = "",
                     info = "agentlink/v1/keystore-file" (ALKS) | "agentlink/v1/owner-passphrase-wrap" (ALKO))
  blob = header || AES-256-GCM(kek, nonce, plaintext, AAD = header)
  ALKS plaintext = entries `u16be nameLen | name (UTF-8) | u32be valueLen | value`;
  ALKO plaintext = exactly the 32-byte owner seed.
  password: a secret read from a file first loses one trailing \\n or \\r\\n. Kind 1 (generated
  code): refuse non-ASCII, remove spaces and dashes, ASCII upper case, map 0/1/8 to O/I/B, require
  24 base32 characters, password = the 15 decoded bytes. Kind 2: fatal UTF-8 decoding (invalid
  sequences, overlong forms and lone surrogates refused), C0 and C1 control characters refused,
  then the UTF-8 of NFKC, spaces kept.
Argon2id (v1.3), HKDF and AES-GCM are `cryptography` (Argon2id checked against RFC 9106 in
`owner-wrap`, HKDF against RFC 5869 in `hkdf-derive`); owner keys come from the 04 §2.1 derivation
of `generate_hkdf_derive.py`. Secrets, salts, nonces and entries are synthetic test values.

Runtimes: Node only, as 04 §2.8 states for the file KeyStore (IR-M1-1h-1 Q7).

The agent ID is the agent's EVM address (04 §2.9): `0x` + 40 lowercase hex in the header and as the
expected ID, and after decryption the `seed` entry must derive it (its agentlink/v1/evm key at epoch 0).

Usage: python3 -I tools/vectors/generate_keystore_file.py --check [FILE] | --write
"""

import base64
import re
import sys
import unicodedata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import generate_hkdf_derive as hkdf  # noqa: E402
import vectorlib as v  # noqa: E402

SUITE = "keystore-file"
VERSION = 1
SPEC = "04 §2.8 ALKS v1"
SPEC_ALKO = "04 §2.8 ALKO v1"
SPEC_PASSWORD = "04 §2.8 password()"
ALKS_INFO = b"agentlink/v1/keystore-file"
ALKO_INFO = b"agentlink/v1/owner-passphrase-wrap"
FLOOR = (19456, 2, 1)
DEFAULT = (65536, 3, 1)
BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"


# --- reference implementation of the formats -----------------------------------------------------


def password(secret, kind, source="prompt"):
    if isinstance(secret, bytes):
        secret = secret.decode("utf-8", errors="strict")  # fatal: invalid, overlong, surrogates refused
    if any(0xD800 <= ord(c) <= 0xDFFF for c in secret):
        raise ValueError("lone surrogate")
    if source == "file":
        if secret.endswith("\r\n"):
            secret = secret[:-2]
        elif secret.endswith("\n"):
            secret = secret[:-1]
    if kind == 1:
        if any(ord(c) > 0x7F for c in secret):
            raise ValueError("non-ASCII in a generated code")
        code = secret.replace(" ", "").replace("-", "").upper()
        code = code.replace("0", "O").replace("1", "I").replace("8", "B")
        if len(code) != 24 or any(c not in BASE32 for c in code):
            raise ValueError("not a 24-character code")
        return base64.b32decode(code)
    if kind == 2:
        if any(ord(c) <= 0x1F or 0x7F <= ord(c) <= 0x9F for c in secret):
            raise ValueError("control character")
        return unicodedata.normalize("NFKC", secret).encode("utf-8")
    raise ValueError("unknown secretKind")


def kek(secret, kind, salt, m, t, p, info=ALKS_INFO, source="prompt"):
    return v.hkdf_sha256(v.argon2id(password(secret, kind, source), salt, m, t, p, 32), b"", info, 32)


def header(kind, m, t, p, salt, nonce, agent_id, version=1, kdf=1, aead=1, id_len=None, magic=b"ALKS"):
    raw_id = agent_id.encode("utf-8")
    h = magic + v.u8(version) + v.u8(kind) + v.u8(kdf) + v.u32be(m) + v.u8(t) + v.u8(p) + salt + v.u8(aead) + nonce
    if magic == b"ALKO":
        return h
    return h + v.u8(len(raw_id) if id_len is None else id_len) + raw_id


def entries_bytes(entries):
    out = b""
    for name, value in entries:
        raw = name.encode("utf-8") if isinstance(name, str) else name
        out += v.u16be(len(raw)) + raw + v.u32be(len(value)) + value
    return out


def seal(secret, kind, m, t, p, salt, nonce, agent_id, plaintext, info=ALKS_INFO, **header_overrides):
    h = header(kind, m, t, p, salt, nonce, agent_id, **header_overrides)
    return h + v.aes256gcm_encrypt(kek(secret, kind, salt, m, t, p, info), nonce, plaintext, h)


def check_params(kind, m, t, p):
    if kind not in (1, 2):
        raise ValueError("unknown secretKind")
    if m < 19456 or m > 262144 or t < 2 or t > 8 or p < 1 or p > 4:
        raise ValueError("KDF parameters out of bounds")


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
        name = plaintext[i : i + n].decode("utf-8")  # invalid UTF-8 is refused
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


AGENT_ID = re.compile(r"[A-Za-z0-9_-]{1,64}")  # the format's general rule (04 §2.8)
AGENT_ID_29 = re.compile(r"0x[0-9a-f]{40}")  # the exact agent ID form (04 §2.9)


def agent_id_of(seed):
    """04 §2.9: the agent ID is the EVM address of the seed's agentlink/v1/evm key at epoch 0."""
    return v.evm_address(hkdf.secp_secret(seed, hkdf.EVM, 0))


def open_alks(data, secret, expected_agent_id, source="prompt"):
    """Every ALKS refusal of 04 §2.8 that applies without an agentId derivation (G-23)."""
    if not AGENT_ID.fullmatch(expected_agent_id) or not AGENT_ID_29.fullmatch(expected_agent_id):
        raise ValueError("invalid expected agentId")
    if len(data) < 60 or data[:4] != b"ALKS" or data[4] != 1 or data[6] != 1 or data[29] != 1:
        raise ValueError("bad header")
    kind, m, t, p = data[5], int.from_bytes(data[7:11], "big"), data[11], data[12]
    check_params(kind, m, t, p)
    id_len = data[42]
    if not 1 <= id_len <= 64 or len(data) < 43 + id_len + 16:
        raise ValueError("bad idLen")
    agent_id = data[43 : 43 + id_len].decode("ascii", "replace")
    if not AGENT_ID.fullmatch(agent_id) or not AGENT_ID_29.fullmatch(agent_id) or agent_id != expected_agent_id:
        raise ValueError("agentId mismatch")
    h = data[: 43 + id_len]
    pw = password(secret, kind, source)  # refuses before the KDF runs
    key = v.hkdf_sha256(v.argon2id(pw, data[13:29], m, t, p, 32), b"", ALKS_INFO, 32)
    entries = parse_entries(v.aes256gcm_decrypt(key, data[30:42], data[len(h) :], h))
    seeds = [value for name, value in entries if name == "seed"]
    # After decryption the seed entry must derive the expected agent ID, compared as bytes (§2.8, §2.9).
    if len(seeds) != 1 or bytes.fromhex(agent_id_of(seeds[0])[2:]) != bytes.fromhex(expected_agent_id[2:]):
        raise ValueError("the seed entry does not derive the expected agent ID")
    return entries


def owner_keys(seed):
    """The owner keys a card names: ownerEvm and ownerNostr, at epoch 0 (04 §2.1; owner-key
    rotation is P2, 04 §2.6)."""
    evm = v.evm_address(hkdf.secp_secret(seed, hkdf.EVM, 0))
    nostr = "0x" + v.hx(v.xonly_public_key(hkdf.secp_secret(seed, hkdf.NOSTR, 0)))
    return {"ownerEvm": evm, "ownerNostr": nostr}


def open_alko(data, secret, expected_owner, file_keystore_machine, source="prompt"):
    if len(data) != 90:
        raise ValueError("an ALKO blob is exactly 90 bytes")
    if data[:4] != b"ALKO" or data[4] != 1 or data[6] != 1 or data[29] != 1:
        raise ValueError("bad header")
    kind, m, t, p = data[5], int.from_bytes(data[7:11], "big"), data[11], data[12]
    check_params(kind, m, t, p)
    if file_keystore_machine and kind != 1:
        raise ValueError("file-KeyStore machines require a generated owner code")
    pw = password(secret, kind, source)
    key = v.hkdf_sha256(v.argon2id(pw, data[13:29], m, t, p, 32), b"", ALKO_INFO, 32)
    seed = v.aes256gcm_decrypt(key, data[30:42], data[42:], data[:42])
    keys = owner_keys(seed)
    if bytes.fromhex(keys["ownerEvm"][2:]) != bytes.fromhex(expected_owner["ownerEvm"][2:]) or bytes.fromhex(
        keys["ownerNostr"][2:]
    ) != bytes.fromhex(expected_owner["ownerNostr"][2:]):
        raise ValueError("seed does not derive the expected owner")
    return seed


def refused(fn, *args):
    try:
        fn(*args)
    except Exception:
        return True
    return False


# --- cases ---------------------------------------------------------------------------------------


def build():
    cases = []
    passphrase = "correct horse battery staple"
    unicode_passphrase = "Ｐａｓｓ ﬁle Café ✓ keystore"
    code = base64.b32encode(v.det("keystore-file/agent-code", 15)).decode("ascii")
    code_spelled = "-".join(code[i : i + 4] for i in range(0, 24, 4)).lower()
    seed = v.det("keystore-file/seed", 32)
    seed2, seed3, seed4 = (v.det(f"keystore-file/seed-{i}", 32) for i in (2, 3, 4))
    A1, A2, A3, A4 = (agent_id_of(x) for x in (seed, seed2, seed3, seed4))
    store_key = v.det("keystore-file/store-key", 32)
    s3 = b'{"accessKeyId":"TESTONLY","secret":"' + base64.b64encode(v.det("keystore-file/s3", 30)) + b'"}'
    entries1 = [("seed", seed), ("store-key", store_key)]
    entries2 = [("seed", seed4), ("store-key", store_key), ("s3:primary", s3)]
    entries_a2 = [("seed", seed2), ("store-key", store_key)]
    entries_a3 = [("seed", seed3), ("store-key", store_key)]

    def entry_fields(entries):
        out = {"entryNames": ",".join(name for name, _ in entries)}
        out.update({f"entry:{name}": v.hx(value) for name, value in entries})
        return out

    files = {}

    def file_case(case_id, why, secret, kind, params, agent_id, entries, salt_label, nonce_label):
        salt, nonce = v.det(f"keystore-file/{salt_label}", 16), v.det(f"keystore-file/{nonce_label}", 12)
        data = seal(secret, kind, *params, salt, nonce, agent_id, entries_bytes(entries))
        if open_alks(data, secret, agent_id) != entries:
            v.fail(f"{case_id} does not open")
        files[case_id] = data
        m, t, p = params
        common = {"secretKind": kind, "secret": secret, "source": "prompt", "salt": v.hx(salt), "memoryKiB": m, "iterations": t, "parallelism": p}
        cases.append(v.case(f"kek-{case_id}", f"{SPEC} kek ({why})", {"op": "kek", "format": "ALKS", **common}, {"kek": v.hx(kek(secret, kind, salt, *params))}))
        cases.append(
            v.case(
                f"seal-{case_id}",
                f"{SPEC} seal ({why})",
                {"op": "seal", **common, "nonce": v.hx(nonce), "agentId": agent_id, "entries": [{"name": n, "value": v.hx(val)} for n, val in entries]},
                {"file": v.hx(data)},
            )
        )
        cases.append(v.case(f"open-{case_id}", f"{SPEC} open ({why})", open_input(data, secret, agent_id), entry_fields(entries)))
        return data

    def open_input(data, secret, expected, source="prompt"):
        return {"op": "open", "file": v.hx(data), "secret": secret, "source": source, "expectedAgentId": expected}

    f1 = file_case("floor", "KDF floor m = 19 MiB, t = 2, p = 1", passphrase, 2, FLOOR, A1, entries1, "salt-1", "nonce-1")
    file_case("default", "default m = 64 MiB, t = 3, p = 1; storage credential entry", unicode_passphrase, 2, DEFAULT, A4, entries2, "salt-2", "nonce-2")
    cases.append(
        v.case(
            "open-default-nfkc-equivalent",
            f"{SPEC} open with the NFKC-equivalent spelling of the passphrase",
            open_input(files["default"], unicodedata.normalize("NFKC", unicode_passphrase), A4),
            entry_fields(entries2),
        )
    )
    other_agent = file_case("other-agent", "a second agent with the same passphrase", passphrase, 2, FLOOR, A2, entries_a2, "salt-3", "nonce-3")
    code_file = file_case("code", f"secretKind 1, generated unlock code; {SPEC_PASSWORD}", code, 1, DEFAULT, A3, entries_a3, "salt-4", "nonce-4")
    cases.append(
        v.case(
            "open-code-other-spelling",
            f"{SPEC} open with the code in lower case with dashes ({SPEC_PASSWORD})",
            open_input(code_file, code_spelled, A3),
            entry_fields(entries_a3),
        )
    )
    cases.append(
        v.case(
            "open-code-from-file",
            f"{SPEC} open with the code read from a file with a trailing CRLF ({SPEC_PASSWORD})",
            open_input(code_file, code + "\r\n", A3, "file"),
            entry_fields(entries_a3),
        )
    )
    for case_id, m, t, p in [("cap-memory", 262144, 2, 1), ("cap-iterations", 19456, 8, 1), ("cap-parallelism", 19456, 2, 4)]:
        salt = v.det(f"keystore-file/{case_id}/salt", 16)
        nonce = v.det(f"keystore-file/{case_id}/nonce", 12)
        data = seal(passphrase, 2, m, t, p, salt, nonce, A1, entries_bytes(entries1))
        if open_alks(data, passphrase, A1) != entries1:
            v.fail(f"{case_id} does not open")
        cases.append(v.case(f"open-{case_id}", f"{SPEC}: KDF parameters at the cap (m = {m} KiB, t = {t}, p = {p}) are accepted", open_input(data, passphrase, A1), entry_fields(entries1)))

    # 64 KiB boundary: exactly 65536 bytes of plaintext opens; one more byte is refused.
    big = [("seed", seed), ("blob", v.det("keystore-file/blob", 65536 - (2 + 4 + 4 + 32) - (2 + 4 + 4)))]
    if len(entries_bytes(big)) != 65536:
        v.fail("boundary plaintext is not 64 KiB")
    salt1, nonce1 = v.det("keystore-file/salt-1", 16), v.det("keystore-file/nonce-1", 12)
    big_file = seal(passphrase, 2, *FLOOR, salt1, nonce1, A1, entries_bytes(big))
    if open_alks(big_file, passphrase, A1) != big:
        v.fail("64 KiB plaintext does not open")
    cases.append(v.case("open-plaintext-64-kib", f"{SPEC}: plaintext of exactly 64 KiB is accepted", open_input(big_file, passphrase, A1), entry_fields(big)))

    def reject(case_id, why, data, secret=passphrase, expected=A1, source="prompt"):
        if not refused(open_alks, data, secret, expected, source):
            v.fail(f"{case_id} opens")
        cases.append(v.case(case_id, f"{SPEC}: {why}", open_input(data, secret, expected, source), {"outcome": "reject"}))

    def flipped(data, offset, mask=0x01):
        out = bytearray(data)
        out[offset] ^= mask
        return bytes(out)

    reject("open-reject-wrong-passphrase", "wrong passphrase", f1, secret="correct horse battery stapler")
    reject("open-reject-passphrase-trailing-newline", "a trailing newline typed at a prompt is part of the passphrase", f1, secret=passphrase + "\n")
    reject("open-reject-code-wrong", "another code", code_file, secret=base64.b32encode(v.det("keystore-file/other-code", 15)).decode(), expected=A3)
    for field, offset in [
        ("magic", 0), ("version", 4), ("secret-kind", 5), ("kdf", 6), ("memory", 10), ("iterations", 11),
        ("parallelism", 12), ("salt", 13), ("aead", 29), ("nonce", 30), ("id-len", 42), ("agent-id", 43),
    ]:
        reject(f"open-reject-flip-{field}", f"header byte flipped ({field})", flipped(f1, offset))
    header_len = 43 + len(A1)
    reject("open-reject-flip-ciphertext", "ciphertext byte flipped", flipped(f1, header_len))
    reject("open-reject-flip-tag", "tag byte flipped", flipped(f1, len(f1) - 1))
    reject("open-reject-truncated-tag", "file truncated by one byte", f1[:-1])
    reject("open-reject-truncated-to-header", "file truncated to its header", f1[:header_len])
    reject("open-reject-truncated-in-header", "file truncated inside the header", f1[:20])
    reject("open-reject-empty", "empty file", b"")

    salt, nonce = salt1, nonce1
    plain1 = entries_bytes(entries1)

    def sealed(**overrides):
        params = dict(m=FLOOR[0], t=FLOOR[1], p=FLOOR[2], kind=2, agent_id=A1, plaintext=plain1)
        params.update(overrides)
        header_args = {k: params.pop(k) for k in ["version", "kdf", "aead", "id_len"] if k in params}
        return seal(passphrase, params["kind"], params["m"], params["t"], params["p"], salt, nonce, params["agent_id"], params["plaintext"], **header_args)

    def crafted(kind=2, **fields):
        """A header with values the format forbids, sealed under the otherwise valid kek."""
        h = header(kind, *FLOOR, salt, nonce, A1, **fields)
        return h + v.aes256gcm_encrypt(kek(passphrase, 2, salt, *FLOOR), nonce, plain1, h)

    reject("open-reject-version-2", "unknown version", crafted(version=2))
    reject("open-reject-kdf-2", "unknown kdf", crafted(kdf=2))
    reject("open-reject-aead-2", "unknown aead", crafted(aead=2))
    for kind in (0, 3):
        reject(f"open-reject-secret-kind-{kind}", "unknown secretKind", crafted(kind=kind))
    for case_id, why, m, t, p in [
        ("memory-below-floor", "m below 19 MiB", 19455, 2, 1),
        ("iterations-below-floor", "t below 2", 19456, 1, 1),
        ("memory-above-cap", "m above 256 MiB", 262145, 2, 1),
        ("iterations-above-cap", "t above 8", 19456, 9, 1),
        ("parallelism-above-cap", "p above 4", 19456, 2, 5),
    ]:
        reject(f"open-reject-{case_id}", f"KDF parameters out of bounds ({why}), refused before the KDF runs", sealed(m=m, t=t, p=p))
    h = header(2, FLOOR[0], FLOOR[1], 0, salt, nonce, A1)
    reject("open-reject-parallelism-zero", "KDF parameters out of bounds (p = 0), refused before the KDF runs", h + bytes(len(plain1) + 16))
    reject("open-reject-id-len-zero", "idLen = 0 (no agentId)", sealed(agent_id=""))
    reject("open-reject-id-len-65", "idLen above 64", sealed(agent_id="a" * 65), expected="a" * 64)
    reject("open-reject-agent-id-charset", "agentId outside [A-Za-z0-9_-]", sealed(agent_id="agent.01"), expected=A1)
    # 04 §2.8, §2.9: the agent ID is the exact 0x + 40 lowercase hex form, checked before any path.
    for case_id, bad in [
        ("checksummed", v.eip55(A1)),
        ("uppercase", "0x" + A1[2:].upper()),
        ("no-prefix", A1[2:]),
        ("39-hex", A1[:-1]),
        ("legacy-handle", "agent_01"),
    ]:
        reject(f"open-reject-expected-id-{case_id}", f"an expected agent ID that is not in the exact §2.9 form ({case_id})", f1, expected=bad)
    reject("open-reject-header-id-checksummed", "a header agent ID in EIP-55 form (sealed validly under it)", sealed(agent_id=v.eip55(A1)), expected=A1)
    reject("open-reject-seed-other-agent", "the seed entry derives another agent ID (sealed validly under A1's header)", sealed(plaintext=entries_bytes(entries_a2)))
    reject("open-reject-no-seed-entry", "no seed entry, so nothing derives the agent ID", sealed(plaintext=entries_bytes([("store-key", store_key)])))
    reject("open-reject-expected-id-path", "an expected agentId of ../owner is refused before any path is built", f1, expected="../owner")
    reject("open-reject-other-agent", "another agent's file with the same passphrase (header agentId differs)", other_agent)
    reject("open-reject-expected-id-mismatch", "the file's agentId differs from the agent being opened", f1, expected=A2)

    dup = entries_bytes([("seed", seed), ("seed", store_key)])
    reject("open-reject-duplicate-entry", "duplicate entry names", sealed(plaintext=dup))
    reject("open-reject-name-length-overflow", "entry name length past the end", sealed(plaintext=v.u16be(200) + b"seed"))
    reject("open-reject-value-length-overflow", "entry value length past the end", sealed(plaintext=v.u16be(4) + b"seed" + v.u32be(33) + seed))
    reject("open-reject-trailing-byte", "trailing bytes after the last entry", sealed(plaintext=plain1 + b"\x00"))
    reject("open-reject-invalid-utf8-name", "an entry name that is not UTF-8", sealed(plaintext=entries_bytes([(b"se\xffd", seed)])))
    too_big = [("seed", seed), ("blob", v.det("keystore-file/blob", 65536 - (2 + 4 + 4 + 32) - (2 + 4 + 4) + 1))]
    reject("open-reject-plaintext-above-64-kib", "plaintext above 64 KiB", sealed(plaintext=entries_bytes(too_big)))

    # password(): file and prompt input, both kinds.
    canonical = "OBIS7Q2MKXW4RT5ZLDNE3H6C"
    canonical_bytes = base64.b32decode(canonical)
    for case_id, raw, source in [
        ("canonical", canonical, "prompt"),
        ("lowercase-dashes", "obis-7q2m-kxw4-rt5z-ldne-3h6c", "prompt"),
        ("groups-of-four", "OBIS 7Q2M KXW4 RT5Z LDNE 3H6C", "prompt"),
        ("digits-for-letters", "0B1S 7Q2M KXW4 RT5Z LDNE 3H6C", "prompt"),
        ("eight-for-b", "o8is7q2mkxw4rt5zldne3h6c", "prompt"),
        ("file-lf", canonical + "\n", "file"),
        ("file-crlf", canonical + "\r\n", "file"),
    ]:
        if password(raw, 1, source) != canonical_bytes:
            v.fail(f"password of {raw!r}")
        cases.append(v.case(f"password-code-{case_id}", f"{SPEC_PASSWORD}, kind 1: the 15 decoded bytes", {"op": "password", "secretKind": 1, "secret": raw, "source": source}, {"password": v.hx(canonical_bytes)}))
    for case_id, raw, source in [
        ("23-chars", canonical[:-1], "prompt"),
        ("25-chars", canonical + "A", "prompt"),
        ("digit-9", canonical[:-1] + "9", "prompt"),
        ("padding", canonical[:-1] + "=", "prompt"),
        ("dot-separator", "OBIS.7Q2M.KXW4.RT5Z.LDNE.3H6C", "prompt"),
        ("tab", "OBIS\t7Q2M KXW4 RT5Z LDNE 3H6C", "prompt"),
        ("non-ascii-letter", canonical[:-1] + "Ä", "prompt"),
        ("long-s", "OBIſ7Q2MKXW4RT5ZLDNE3H6C", "prompt"),
        ("dotless-i", "OBıS7Q2MKXW4RT5ZLDNE3H6C", "prompt"),
        ("fullwidth", "ＯBIS7Q2MKXW4RT5ZLDNE3H6C", "prompt"),
        ("prompt-trailing-newline", canonical + "\n", "prompt"),
        ("file-two-newlines", canonical + "\n\n", "file"),
    ]:
        if not refused(password, raw, 1, source):
            v.fail(f"code {raw!r} accepted")
        cases.append(v.case(f"password-code-reject-{case_id}", f"{SPEC_PASSWORD}, kind 1: refused before the KDF", {"op": "password", "secretKind": 1, "secret": raw, "source": source}, {"outcome": "reject"}))
    for case_id, raw, source in [
        ("ascii", passphrase, "prompt"),
        ("fullwidth-and-ligature", unicode_passphrase, "prompt"),
        ("spaces-kept", "  two  spaces  inside  ", "prompt"),
        ("combining-accent", "Cafe\u0301 passphrase", "prompt"),
        ("no-break-space", "two\u00a0words passphrase", "prompt"),
        ("file-lf", passphrase + "\n", "file"),
        ("file-crlf", passphrase + "\r\n", "file"),
    ]:
        cases.append(v.case(f"password-passphrase-{case_id}", f"{SPEC_PASSWORD}, kind 2: UTF-8 of NFKC", {"op": "password", "secretKind": 2, "secret": raw, "source": source}, {"password": v.hx(password(raw, 2, source))}))
    for case_id, raw, source in [
        ("prompt-trailing-newline", passphrase + "\n", "prompt"),
        ("file-two-newlines", passphrase + "\n\n", "file"),
        ("file-cr-only", passphrase + "\r", "file"),
        ("tab", "correct\thorse battery staple", "prompt"),
        ("nul", "correct horse\u0000battery staple", "prompt"),
        ("escape", "correct horse \u001b[0mbattery staple", "prompt"),
        ("delete", "correct horse battery staple\u007f", "prompt"),
        ("c1-next-line", "correct horse\u0085battery staple", "prompt"),
        ("c1-last", "correct horse battery staple\u009f", "prompt"),
    ]:
        if not refused(password, raw, 2, source):
            v.fail(f"passphrase {case_id} accepted")
        cases.append(v.case(f"password-passphrase-reject-{case_id}", f"{SPEC_PASSWORD}, kind 2: a C0 or C1 control character is refused", {"op": "password", "secretKind": 2, "secret": raw, "source": source}, {"outcome": "reject"}))
    # Fatal UTF-8 (kind 2 step 1), and kind 1's ASCII-only rule, on raw input bytes.
    for case_id, kind, raw, source in [
        ("utf8-valid", 2, "Caf\u00e9 passphrase".encode("utf-8"), "prompt"),
        ("utf8-file-crlf", 2, b"correct horse battery staple\r\n", "file"),
        ("code-ascii", 1, canonical.lower().encode("ascii"), "prompt"),
    ]:
        cases.append(v.case(f"password-bytes-{case_id}", f"{SPEC_PASSWORD}: input given as bytes", {"op": "passwordBytes", "secretKind": kind, "secretBytes": v.hx(raw), "source": source}, {"password": v.hx(password(raw, kind, source))}))
    for case_id, kind, raw, why in [
        ("invalid-continuation", 2, b"pass\xc3\x28word phrase", "an invalid UTF-8 sequence"),
        ("lone-continuation", 2, b"pass\x80word phrase", "a stray continuation byte"),
        ("overlong-slash", 2, b"pass\xc0\xafword phrase", "an overlong form"),
        ("overlong-nul", 2, b"pass\xc0\x80word phrase", "an overlong NUL"),
        ("encoded-surrogate", 2, b"pass\xed\xa0\x80word phrase", "a UTF-8-encoded lone surrogate"),
        ("truncated", 2, b"passphrase \xe2\x82", "a truncated sequence"),
        ("ff-byte", 2, b"passphrase \xff", "the byte FF"),
        ("code-non-ascii", 1, canonical[:-1].encode("ascii") + b"\xc3\x84", "a non-ASCII byte in a generated code"),
    ]:
        if not refused(password, raw, kind, "prompt"):
            v.fail(f"bytes {case_id} accepted")
        cases.append(v.case(f"password-bytes-reject-{case_id}", f"{SPEC_PASSWORD}: {why} is refused, never replaced", {"op": "passwordBytes", "secretKind": kind, "secretBytes": v.hx(raw), "source": "prompt"}, {"outcome": "reject"}))
    cases.append(v.case("password-reject-kind-3", f"{SPEC_PASSWORD}: unknown secretKind", {"op": "password", "secretKind": 3, "secret": passphrase, "source": "prompt"}, {"outcome": "reject"}))

    # ALKO v1: the owner seed under an owner code (kind 1) or passphrase (kind 2).
    owner_seed = v.det("keystore-file/owner-seed", 32)
    owner = owner_keys(owner_seed)
    other_owner = owner_keys(v.det("keystore-file/other-owner-seed", 32))
    owner_code = base64.b32encode(v.det("keystore-file/owner-code", 15)).decode("ascii")
    alko = {}

    def alko_seal(secret, kind, params, salt_label, nonce_label, plaintext=owner_seed, info=ALKO_INFO, **overrides):
        salt_, nonce_ = v.det(f"keystore-file/{salt_label}", 16), v.det(f"keystore-file/{nonce_label}", 12)
        h = header(kind, *params, salt_, nonce_, "", magic=b"ALKO", **overrides)
        return h + v.aes256gcm_encrypt(kek(secret, kind, salt_, *params, info), nonce_, plaintext, h)

    def alko_input(data, secret, expected=owner, file_machine=True, source="prompt"):
        return {"op": "openAlko", "file": v.hx(data), "secret": secret, "source": source, "expectedOwner": expected, "fileKeystoreMachine": file_machine}

    for case_id, why, secret, kind, params, file_machine in [
        ("alko-code", "kind 1, generated owner code, default parameters", owner_code, 1, DEFAULT, True),
        ("alko-passphrase", "kind 2, chosen owner passphrase (machines with a keychain)", passphrase, 2, FLOOR, False),
    ]:
        salt_, nonce_ = v.det(f"keystore-file/{case_id}/salt", 16), v.det(f"keystore-file/{case_id}/nonce", 12)
        data = alko_seal(secret, kind, params, f"{case_id}/salt", f"{case_id}/nonce")
        if len(data) != 90 or open_alko(data, secret, owner, file_machine) != owner_seed:
            v.fail(f"{case_id} does not open")
        alko[case_id] = data
        m, t, p = params
        common = {"secretKind": kind, "secret": secret, "source": "prompt", "salt": v.hx(salt_), "memoryKiB": m, "iterations": t, "parallelism": p}
        cases.append(v.case(f"kek-{case_id}", f"{SPEC_ALKO} kek ({why})", {"op": "kek", "format": "ALKO", **common}, {"kek": v.hx(kek(secret, kind, salt_, *params, ALKO_INFO))}))
        cases.append(v.case(f"seal-{case_id}", f"{SPEC_ALKO} seal ({why})", {"op": "sealAlko", **common, "nonce": v.hx(nonce_), "seed": v.hx(owner_seed)}, {"file": v.hx(data)}))
        cases.append(v.case(f"open-{case_id}", f"{SPEC_ALKO} open ({why}); the seed derives the card's ownerEvm and ownerNostr", alko_input(data, secret, file_machine=file_machine), {"seed": v.hx(owner_seed)}))
    cases.append(v.case("open-alko-code-spelled", f"{SPEC_ALKO} open with the owner code in lower case with dashes", alko_input(alko["alko-code"], "-".join(owner_code[i : i + 4] for i in range(0, 24, 4)).lower()), {"seed": v.hx(owner_seed)}))

    def alko_reject(case_id, why, data, secret=owner_code, expected=owner, file_machine=True):
        if not refused(open_alko, data, secret, expected, file_machine):
            v.fail(f"{case_id} opens")
        cases.append(v.case(case_id, f"{SPEC_ALKO}: {why}", alko_input(data, secret, expected, file_machine), {"outcome": "reject"}))

    a1 = alko["alko-code"]
    alko_reject("open-alko-reject-wrong-code", "another owner code", a1, secret=base64.b32encode(v.det("keystore-file/other-code", 15)).decode())
    alko_reject("open-alko-reject-other-owner", "the seed does not derive the expected owner", a1, expected=other_owner)
    alko_reject("open-alko-reject-passphrase-on-file-machine", "secretKind 2 on a file-KeyStore machine, refused before the KDF", alko["alko-passphrase"], secret=passphrase, file_machine=True)
    alko_reject("open-alko-reject-89-bytes", "89 bytes, refused before the KDF", a1[:-1])
    alko_reject("open-alko-reject-91-bytes", "91 bytes, refused before the KDF", a1 + b"\x00")
    alko_reject("open-alko-reject-seed-31-bytes", "a 31-byte seed (blob of 89 bytes, sealed validly)", alko_seal(owner_code, 1, DEFAULT, "alko-code/salt", "alko-code/nonce", plaintext=owner_seed[:31]))
    alko_reject("open-alko-reject-seed-33-bytes", "a 33-byte seed (blob of 91 bytes, sealed validly)", alko_seal(owner_code, 1, DEFAULT, "alko-code/salt", "alko-code/nonce", plaintext=owner_seed + b"\x00"))
    for field, offset in [("magic", 0), ("version", 4), ("kdf", 6), ("memory", 10), ("salt", 13), ("aead", 29), ("nonce", 30)]:
        alko_reject(f"open-alko-reject-flip-{field}", f"header byte flipped ({field})", flipped(a1, offset))
    alko_reject("open-alko-reject-flip-tag", "tag byte flipped", flipped(a1, 89))
    alko_reject("open-alko-reject-alks-label", "an ALKO blob sealed under the ALKS label (agentlink/v1/keystore-file)", alko_seal(owner_code, 1, DEFAULT, "alko-code/salt", "alko-code/nonce", info=ALKS_INFO))
    alko_reject("open-alko-reject-alks-magic", "an ALKS file given to the ALKO reader", code_file, secret=code)
    # The reverse: ALKS readers refuse ALKO bytes and ALKS files sealed under the ALKO label.
    reject("open-reject-alko-blob", "an ALKO blob given to the ALKS reader", a1, secret=owner_code)
    reject("open-reject-alko-label", "an ALKS file sealed under the ALKO label (agentlink/v1/owner-passphrase-wrap)", seal(passphrase, 2, *FLOOR, salt, nonce, A1, plain1, info=ALKO_INFO))
    patched = b"ALKS" + a1[4:]
    alko_reject("open-alko-reject-magic-patched", "ALKS magic on an ALKO blob", patched)
    return cases


SECRET_SOURCE = {"enum": ["prompt", "file"]}
OWNER = v.strict_object({"ownerEvm": v.ADDRESS, "ownerNostr": {"type": "string", "pattern": "^0x[0-9a-f]{64}$"}})
ENTRY = v.strict_object({"name": v.STRING, "value": v.HEX})
OPEN_OK = {"type": "object", "required": ["entryNames"], "properties": {"entryNames": v.STRING}, "patternProperties": {"^entry:": v.HEX}, "additionalProperties": False}
KDF_FIELDS = {"secretKind": v.INTEGER, "secret": v.STRING, "source": SECRET_SOURCE, "salt": v.hexn(16), "memoryKiB": v.INTEGER, "iterations": v.INTEGER, "parallelism": v.INTEGER}
SCHEMA = v.case_schema(
    SUITE,
    "04 §2.8 ALKS v1 and ALKO v1. `password` / `passwordBytes`: the Argon2id password bytes for a "
    "secret (text or raw bytes), its kind and its source (file input loses one trailing newline), "
    "or a rejection. `kek`: the key-"
    "encryption key for `format` ALKS or ALKO. `seal` / `sealAlko`: the whole blob as hex. `open`: "
    "entry names (comma-separated, in file order) and each value as `entry:<name>` hex, or a "
    "rejection. `openAlko`: the 32-byte owner seed, or a rejection.",
    {
        "password": ({"secretKind": v.INTEGER, "secret": v.STRING, "source": SECRET_SOURCE}, [{"password": v.HEX}, v.REJECT]),
        "passwordBytes": ({"secretKind": v.INTEGER, "secretBytes": v.HEX, "source": SECRET_SOURCE}, [{"password": v.HEX}, v.REJECT]),
        "kek": ({"format": {"enum": ["ALKS", "ALKO"]}, **KDF_FIELDS}, [{"kek": v.hexn(32)}]),
        "seal": ({**KDF_FIELDS, "nonce": v.hexn(12), "agentId": v.STRING, "entries": {"type": "array", "items": ENTRY}}, [{"file": v.HEX}]),
        "open": ({"file": v.HEX, "secret": v.STRING, "source": SECRET_SOURCE, "expectedAgentId": v.STRING}, [v.REJECT]),
        "sealAlko": ({**KDF_FIELDS, "nonce": v.hexn(12), "seed": v.hexn(32)}, [{"file": v.HEX}]),
        "openAlko": (
            {"file": v.HEX, "secret": v.STRING, "source": SECRET_SOURCE, "expectedOwner": OWNER, "fileKeystoreMachine": {"type": "boolean"}},
            [{"seed": v.hexn(32)}, v.REJECT],
        ),
    },
)
# `open` succeeds with a variable set of entry fields, which strict_object cannot express.
SCHEMA["oneOf"][4]["properties"]["expected"] = {"oneOf": [OPEN_OK, v.strict_object(v.REJECT)]}

if __name__ == "__main__":
    v.main(
        suite=SUITE,
        version=VERSION,
        script="tools/vectors/generate_keystore_file.py",
        libraries=["cryptography", "coincurve", "pycryptodome"],
        build=build,
        schema=SCHEMA,
        doc=__doc__,
        runtimes=(["node"], "04 §2.8: the file KeyStore runs in Node only (browsers use the passkey PRF, Workers use Worker secrets)"),
    )
