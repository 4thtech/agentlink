#!/usr/bin/env python3
"""Independent generator for the `prf-wrap` suite: the passkey PRF wrap key (M1-1i).

04 §2.3 step 3: the console asks the passkey's PRF extension for one output under the PRF salt
sha256("agentlink-owner-v1") (32 bytes, the value the client passes as the PRF `eval.first` input),
and derives wrapKey = HKDF-SHA256(ikm = PRF output, salt = "" (empty), info = "owner-seed-wrap",
L = 32). HKDF comes from `cryptography` (OpenSSL) and is cross-checked, before anything is written,
against RFC 5869 test case 3 (empty salt and info) and, for every case, against RFC 5869 written out
over hashlib HMAC (vectorlib.hkdf_sha256_written_out).

The PRF outputs are synthetic test values (vectorlib.det), plus all-zero and all-0xff edge values.
A real PRF output comes from the authenticator and never leaves the browser (04 §2.3).

Sealed blobs (D-82, M1-1k):
  ALKP v1 (04 §2.3.1) = "ALKP" | u8 version=1 | u8 aead=1 | ownerNostr 32 B | u16be credIdLen (1..1023)
                        | credId | nonce 12 B | AES-256-GCM(wrapKey, nonce, seed, AAD = header) (32 + 16 B)
  ALKR v1 (04 §2.3.2) = "ALKR" | u8 version=1 | u8 secretKind=1 | u8 kdf=1 | u32be m | u8 t | u8 p
                        | salt 16 B | u8 aead=1 | nonce 12 B | AES-256-GCM(kek, nonce, seed, AAD = header)
                        kek = HKDF-SHA256(Argon2id(password(code, 1), salt, m, t, p, 32), "",
                                          "agentlink/v1/owner-recovery-wrap", 32)
password() is the 04 §2.8 rule from generate_keystore_file.py; owner keys are the 04 §2.1 derivation
of generate_hkdf_derive.py; Argon2id, HKDF and AES-GCM are `cryptography`. A reference opener for each
format is written out below and every accept and reject case is checked against it before anything is
written. Seeds, codes, credential IDs, salts and nonces are synthetic test values. The cross-type
cases give ALKO, ALKS, ALKP and ALKR bytes to the wrong reader, and rewrite a magic.

Usage: python3 -I tools/vectors/generate_prf_wrap.py --check [FILE] | --write
"""

import base64
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import generate_hkdf_derive as hkdf  # noqa: E402
import generate_keystore_file as ksf  # noqa: E402
import vectorlib as v  # noqa: E402

SUITE = "prf-wrap"
VERSION = 1

PRF_SALT_LABEL = b"agentlink-owner-v1"
WRAP_INFO = b"owner-seed-wrap"
RECOVERY_INFO = b"agentlink/v1/owner-recovery-wrap"
SPEC_ALKP = "04 §2.3.1 ALKP v1"
SPEC_ALKR = "04 §2.3.2 ALKR v1"
DEFAULT = (65536, 3, 1)
FLOOR = (19456, 2, 1)
MAX_CRED_ID = 1023

RFC5869_TC3 = {
    "ikm": "0b" * 22,
    "length": 42,
    "okm": "8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8",
}

SPEC = "04 §2.3 step 3"


def wrap_key(prf_output):
    key = v.hkdf_sha256(prf_output, b"", WRAP_INFO, 32)
    if key != v.hkdf_sha256_written_out(prf_output, b"", WRAP_INFO, 32):
        v.fail("cryptography HKDF and the written-out RFC 5869 HKDF differ")
    return key


# --- reference implementation of ALKP and ALKR ---------------------------------------------------


def owner_nostr(seed):
    return v.xonly_public_key(hkdf.secp_secret(seed, hkdf.NOSTR, 0))


def alkp_header(owner, cred_id, nonce, magic=b"ALKP", version=1, aead=1, cred_len=None):
    n = len(cred_id) if cred_len is None else cred_len
    return magic + v.u8(version) + v.u8(aead) + owner + v.u16be(n) + cred_id + nonce


def seal_alkp(prf, seed, cred_id, nonce, plaintext=None, owner=None, **overrides):
    h = alkp_header(owner_nostr(seed) if owner is None else owner, cred_id, nonce, **overrides)
    return h + v.aes256gcm_encrypt(wrap_key(prf), nonce, seed if plaintext is None else plaintext, h)


def open_alkp(blob, prf, expected=None):
    if len(blob) < 54 or blob[:4] != b"ALKP" or blob[4] != 1 or blob[5] != 1:
        raise ValueError("not an ALKP v1 header")
    n = int.from_bytes(blob[38:40], "big")
    if n < 1 or n > MAX_CRED_ID or len(blob) != 100 + n:
        raise ValueError("bad credIdLen or size")
    if len(prf) != 32:
        raise ValueError("a PRF output is 32 bytes")
    owner = blob[6:38]
    if expected is not None and owner != expected:
        raise ValueError("header owner is not the expected owner")
    hlen = 52 + n
    seed = v.aes256gcm_decrypt(wrap_key(prf), blob[hlen - 12 : hlen], blob[hlen:], blob[:hlen])
    if owner_nostr(seed) != owner:
        raise ValueError("seed does not derive the header owner")
    return seed


def alkp_header_fields(blob):
    if len(blob) < 54 or blob[:4] != b"ALKP" or blob[4] != 1 or blob[5] != 1:
        raise ValueError("not an ALKP v1 header")
    n = int.from_bytes(blob[38:40], "big")
    if n < 1 or n > MAX_CRED_ID or len(blob) != 100 + n:
        raise ValueError("bad credIdLen or size")
    return blob[6:38], blob[40 : 40 + n]


def alkr_header(salt, nonce, m, t, p, magic=b"ALKR", version=1, kind=1, kdf=1, aead=1):
    return magic + v.u8(version) + v.u8(kind) + v.u8(kdf) + v.u32be(m) + v.u8(t) + v.u8(p) + salt + v.u8(aead) + nonce


def recovery_kek(code, salt, m, t, p, info=RECOVERY_INFO, source="prompt"):
    return v.hkdf_sha256(v.argon2id(ksf.password(code, 1, source), salt, m, t, p, 32), b"", info, 32)


def seal_alkr(code, seed, salt, nonce, params, plaintext=None, info=RECOVERY_INFO, **overrides):
    h = alkr_header(salt, nonce, *params, **overrides)
    return h + v.aes256gcm_encrypt(recovery_kek(code, salt, *params, info), nonce, seed if plaintext is None else plaintext, h)


def open_alkr(blob, code, expected=None, source="prompt"):
    if len(blob) != 90:
        raise ValueError("an ALKR blob is exactly 90 bytes")
    if blob[:4] != b"ALKR" or blob[4] != 1 or blob[5] != 1 or blob[6] != 1 or blob[29] != 1:
        raise ValueError("not an ALKR v1 header")
    m, t, p = int.from_bytes(blob[7:11], "big"), blob[11], blob[12]
    ksf.check_params(1, m, t, p)
    pw = ksf.password(code, 1, source)
    key = v.hkdf_sha256(v.argon2id(pw, blob[13:29], m, t, p, 32), b"", RECOVERY_INFO, 32)
    seed = v.aes256gcm_decrypt(key, blob[30:42], blob[42:], blob[:42])
    if expected is not None and owner_nostr(seed) != expected:
        raise ValueError("seed does not derive the expected owner")
    return seed


def refused(fn, *args):
    try:
        fn(*args)
    except Exception:
        return True
    return False


def flipped(data, offset):
    out = bytearray(data)
    out[offset] ^= 0x01
    return bytes(out)


def build():
    tc3 = v.hkdf_sha256(bytes.fromhex(RFC5869_TC3["ikm"]), b"", b"", RFC5869_TC3["length"])
    if tc3.hex() != RFC5869_TC3["okm"]:
        v.fail("HKDF does not reproduce RFC 5869 test case 3")
    if v.hkdf_sha256_written_out(bytes.fromhex(RFC5869_TC3["ikm"]), b"", b"", 42).hex() != RFC5869_TC3["okm"]:
        v.fail("the written-out HKDF does not reproduce RFC 5869 test case 3")

    cases = [
        v.case(
            "prf-salt",
            f"{SPEC}: the PRF salt is sha256(utf8(\"agentlink-owner-v1\")), 32 bytes",
            {"op": "prfSalt"},
            {"salt": v.sha256(PRF_SALT_LABEL).hex()},
        )
    ]
    outputs = [
        ("wrap-key-1", "a synthetic PRF output", v.det("prf-wrap/output/1", 32)),
        ("wrap-key-2", "another synthetic PRF output (a different wrapKey)", v.det("prf-wrap/output/2", 32)),
        ("wrap-key-zero", "an all-zero PRF output", bytes(32)),
        ("wrap-key-ff", "an all-0xff PRF output", b"\xff" * 32),
    ]
    keys = set()
    for case_id, why, output in outputs:
        key = wrap_key(output)
        keys.add(key)
        cases.append(
            v.case(
                case_id,
                f"{SPEC}: wrapKey = HKDF-SHA256(ikm = PRF output, salt = \"\", info = \"owner-seed-wrap\", L = 32); {why}",
                {"op": "wrapKey", "prfOutput": output.hex()},
                {"wrapKey": key.hex()},
            )
        )
    if len(keys) != len(outputs):
        v.fail("two PRF outputs give the same wrapKey")
    cases += sealed_cases()
    return cases


def sealed_cases():
    cases = []
    seed = v.det("prf-wrap/seed/1", 32)
    other_seed = v.det("prf-wrap/seed/2", 32)
    owner, other = owner_nostr(seed), owner_nostr(other_seed)
    prf1, prf2 = v.det("prf-wrap/output/1", 32), v.det("prf-wrap/output/2", 32)

    # ALKP v1 --------------------------------------------------------------------------------------
    def open_p(blob, prf, expected):
        return {"op": "openPasskey", "blob": v.hx(blob), "prfOutput": v.hx(prf), "expectedOwnerNostr": "" if expected is None else v.hx(expected)}

    alkp = {}
    for case_id, why, cred in [
        ("passkey-16", "a 16-byte credential ID", v.det("prf-wrap/cred/16", 16)),
        ("passkey-1", "the shortest credential ID (1 byte)", v.det("prf-wrap/cred/1", 1)),
        ("passkey-1023", "the longest credential ID (1023 bytes)", v.det("prf-wrap/cred/1023", 1023)),
    ]:
        nonce = v.det(f"prf-wrap/{case_id}/nonce", 12)
        blob = seal_alkp(prf1, seed, cred, nonce)
        if len(blob) != 100 + len(cred) or open_alkp(blob, prf1, owner) != seed:
            v.fail(f"{case_id}: the reference ALKP opener disagrees")
        alkp[case_id] = (blob, cred, nonce)
        cases.append(v.case(f"seal-{case_id}", f"{SPEC_ALKP} seal ({why}); ownerNostr is derived from the seed", {"op": "sealPasskey", "prfOutput": v.hx(prf1), "seed": v.hx(seed), "credentialId": v.hx(cred), "nonce": v.hx(nonce)}, {"blob": v.hx(blob)}))
        cases.append(v.case(f"open-{case_id}", f"{SPEC_ALKP} open ({why}) with the expected owner", open_p(blob, prf1, owner), {"seed": v.hx(seed)}))
        cases.append(v.case(f"header-{case_id}", f"{SPEC_ALKP} header fields ({why}), read before any passkey prompt", {"op": "passkeyHeader", "blob": v.hx(blob)}, {"ownerNostr": v.hx(owner), "credentialId": v.hx(cred)}))
    p1, cred1, nonce1 = alkp["passkey-16"]
    cases.append(v.case("open-passkey-16-no-expected", f"{SPEC_ALKP} open with no expected owner; the seed still derives the header owner", open_p(p1, prf1, None), {"seed": v.hx(seed)}))

    def reject_p(case_id, why, blob, prf=prf1, expected=None):
        if not refused(open_alkp, blob, prf, expected):
            v.fail(f"{case_id}: the reference ALKP opener accepts it")
        cases.append(v.case(f"open-passkey-reject-{case_id}", f"{SPEC_ALKP}: {why}", open_p(blob, prf, expected), {"outcome": "reject"}))

    reject_p("wrong-prf", "another PRF output (another passkey)", p1, prf=prf2)
    reject_p("prf-31", "a 31-byte PRF output, refused before decryption", p1, prf=prf1[:31])
    reject_p("prf-33", "a 33-byte PRF output, refused before decryption", p1, prf=prf1 + b"\x00")
    reject_p("other-owner", "the header owner is not the expected owner, refused before decryption", p1, expected=other)
    reject_p("truncated", "one byte short", p1[:-1])
    reject_p("extended", "one byte too many", p1 + b"\x00")
    reject_p("header-only", "truncated to the header", p1[: 52 + len(cred1)])
    reject_p("short", "shorter than the smallest header", p1[:30])
    reject_p("empty", "empty", b"")
    reject_p("cred-len-0", "credIdLen 0 (sealed validly)", seal_alkp(prf1, seed, b"", nonce1))
    reject_p("cred-len-1024", "credIdLen 1024 (sealed validly)", seal_alkp(prf1, seed, v.det("prf-wrap/cred/1024", 1024), nonce1))
    reject_p("cred-len-mismatch", "credIdLen one more than the bytes present", p1[:38] + v.u16be(len(cred1) + 1) + p1[40:])
    reject_p("version-2", "version 2 (sealed validly)", seal_alkp(prf1, seed, cred1, nonce1, version=2))
    reject_p("aead-2", "aead 2 (sealed validly)", seal_alkp(prf1, seed, cred1, nonce1, aead=2))
    reject_p("seed-31", "a 31-byte seed (sealed validly), refused by size", seal_alkp(prf1, seed, cred1, nonce1, plaintext=seed[:31]))
    reject_p("seed-33", "a 33-byte seed (sealed validly), refused by size", seal_alkp(prf1, seed, cred1, nonce1, plaintext=seed + b"\x00"))
    reject_p("seed-not-owner", "the seed does not derive the header owner (sealed validly with another owner key)", seal_alkp(prf1, seed, cred1, nonce1, owner=other))
    for field, offset in [("magic", 0), ("version", 4), ("aead", 5), ("owner", 6), ("cred-len", 39), ("cred-id", 40), ("nonce", 40 + len(cred1)), ("ciphertext", 52 + len(cred1)), ("tag", len(p1) - 1)]:
        reject_p(f"flip-{field}", f"one bit flipped ({field})", flipped(p1, offset))
    cases.append(v.case("header-passkey-reject-version-2", f"{SPEC_ALKP}: the header reader refuses version 2", {"op": "passkeyHeader", "blob": v.hx(seal_alkp(prf1, seed, cred1, nonce1, version=2))}, {"outcome": "reject"}))
    cases.append(v.case("header-passkey-reject-truncated", f"{SPEC_ALKP}: the header reader refuses a blob one byte short", {"op": "passkeyHeader", "blob": v.hx(p1[:-1])}, {"outcome": "reject"}))

    # ALKR v1 --------------------------------------------------------------------------------------
    code = base64.b32encode(v.det("prf-wrap/recovery-code", 15)).decode("ascii")
    other_code = base64.b32encode(v.det("prf-wrap/recovery-code/other", 15)).decode("ascii")
    spelled = "-".join(code[i : i + 4] for i in range(0, 24, 4)).lower()

    def open_r(blob, secret, expected, source="prompt"):
        return {"op": "openRecovery", "blob": v.hx(blob), "code": secret, "source": source, "expectedOwnerNostr": "" if expected is None else v.hx(expected)}

    alkr = {}
    for case_id, why, params in [("recovery-default", "default parameters m = 64 MiB, t = 3, p = 1", DEFAULT), ("recovery-floor", "the floor parameters m = 19 MiB, t = 2, p = 1", FLOOR)]:
        salt, nonce = v.det(f"prf-wrap/{case_id}/salt", 16), v.det(f"prf-wrap/{case_id}/nonce", 12)
        blob = seal_alkr(code, seed, salt, nonce, params)
        if len(blob) != 90 or open_alkr(blob, code, owner) != seed:
            v.fail(f"{case_id}: the reference ALKR opener disagrees")
        alkr[case_id] = (blob, salt, nonce)
        m, t, p = params
        cases.append(v.case(f"seal-{case_id}", f"{SPEC_ALKR} seal ({why})", {"op": "sealRecovery", "code": code, "seed": v.hx(seed), "salt": v.hx(salt), "nonce": v.hx(nonce), "memoryKiB": m, "iterations": t, "parallelism": p}, {"blob": v.hx(blob)}))
    r1, salt1, nonce1r = alkr["recovery-default"]
    rf, saltf, noncef = alkr["recovery-floor"]
    cases.append(v.case("open-recovery-default", f"{SPEC_ALKR} open (default parameters) with the expected owner", open_r(r1, code, owner), {"seed": v.hx(seed)}))
    cases.append(v.case("open-recovery-floor-no-expected", f"{SPEC_ALKR} open (floor parameters) with no expected owner", open_r(rf, code, None), {"seed": v.hx(seed)}))
    cases.append(v.case("open-recovery-spelled", f"{SPEC_ALKR} open with the code in six lower-case groups of four with dashes (04 §2.8 password kind 1)", open_r(rf, spelled, owner), {"seed": v.hx(seed)}))
    cases.append(v.case("open-recovery-file-newline", f"{SPEC_ALKR} open with the code read from a file that ends in \\r\\n", open_r(rf, code + "\r\n", owner, "file"), {"seed": v.hx(seed)}))

    def reject_r(case_id, why, blob, secret=code, expected=None, source="prompt"):
        if not refused(open_alkr, blob, secret, expected, source):
            v.fail(f"{case_id}: the reference ALKR opener accepts it")
        cases.append(v.case(f"open-recovery-reject-{case_id}", f"{SPEC_ALKR}: {why}", open_r(blob, secret, expected, source), {"outcome": "reject"}))

    reject_r("wrong-code", "another recovery code", rf, secret=other_code)
    reject_r("mistyped-char", "a character outside the base32 alphabet, refused before the KDF", rf, secret=code[:23] + "!")
    reject_r("23-chars", "23 characters, refused before the KDF", rf, secret=code[:23])
    reject_r("one-char-changed", "one character changed (a mistyped code)", rf, secret=("A" if code[0] != "A" else "B") + code[1:])
    reject_r("other-owner", "the seed does not derive the expected owner", rf, expected=other)
    reject_r("89-bytes", "89 bytes, refused before the KDF", rf[:-1])
    reject_r("91-bytes", "91 bytes, refused before the KDF", rf + b"\x00")
    reject_r("empty", "empty", b"")
    reject_r("seed-31", "a 31-byte seed (sealed validly), refused by size", seal_alkr(code, seed, saltf, noncef, FLOOR, plaintext=seed[:31]))
    reject_r("version-2", "version 2 (sealed validly)", seal_alkr(code, seed, saltf, noncef, FLOOR, version=2))
    reject_r("kdf-2", "kdf 2 (sealed validly)", seal_alkr(code, seed, saltf, noncef, FLOOR, kdf=2))
    reject_r("aead-2", "aead 2 (sealed validly)", seal_alkr(code, seed, saltf, noncef, FLOOR, aead=2))
    reject_r("secret-kind-2", "secretKind 2: a chosen passphrase never wraps a recovery blob (sealed validly)", seal_alkr(code, seed, saltf, noncef, FLOOR, kind=2))
    reject_r("secret-kind-0", "secretKind 0 (sealed validly)", seal_alkr(code, seed, saltf, noncef, FLOOR, kind=0))
    for case_id, why, params in [("m-below-floor", "m = 19455 KiB", (19455, 2, 1)), ("m-above-cap", "m = 262145 KiB", (262145, 2, 1)), ("t-1", "t = 1", (19456, 1, 1)), ("t-9", "t = 9", (19456, 9, 1)), ("p-5", "p = 5", (19456, 2, 5))]:
        h = alkr_header(saltf, noncef, *params)
        reject_r(case_id, f"KDF parameters out of bounds ({why}), refused before the KDF runs", h + rf[42:])
    for field, offset in [("salt", 13), ("nonce", 30), ("ciphertext", 42), ("tag", 89)]:
        reject_r(f"flip-{field}", f"one bit flipped ({field})", flipped(rf, offset))

    # Cross-type -----------------------------------------------------------------------------------
    alko_salt, alko_nonce = v.det("prf-wrap/alko/salt", 16), v.det("prf-wrap/alko/nonce", 12)
    alko_header = ksf.header(1, *FLOOR, alko_salt, alko_nonce, "", magic=b"ALKO")
    alko = alko_header + v.aes256gcm_encrypt(ksf.kek(code, 1, alko_salt, *FLOOR, ksf.ALKO_INFO), alko_nonce, seed, alko_header)
    if ksf.open_alko(alko, code, ksf.owner_keys(seed), True) != seed:
        v.fail("the ALKO reference opener disagrees")
    reject_r("alko-blob", "an ALKO blob under the same code (owner-passphrase-wrap label) given to the ALKR reader", alko)
    reject_r("alko-magic-patched", "an ALKO blob with its magic rewritten to ALKR (AAD and label differ)", b"ALKR" + alko[4:])
    reject_r("alko-label", "an ALKR blob sealed under the ALKO label (agentlink/v1/owner-passphrase-wrap)", seal_alkr(code, seed, saltf, noncef, FLOOR, info=ksf.ALKO_INFO))
    reject_r("alkp-blob", "an ALKP blob given to the ALKR reader", p1)
    alks_salt, alks_nonce = v.det("prf-wrap/alks/salt", 16), v.det("prf-wrap/alks/nonce", 12)
    agent_id = ksf.agent_id_of(seed)
    alks = ksf.seal(code, 1, *FLOOR, alks_salt, alks_nonce, agent_id, ksf.entries_bytes([("seed", seed)]))
    reject_r("alks-file", "an ALKS file under the same code given to the ALKR reader", alks)
    reject_p("alkr-blob", "an ALKR blob given to the ALKP reader", rf)
    reject_p("alko-blob", "an ALKO blob given to the ALKP reader", alko)
    reject_p("alkr-magic", "ALKR magic on an ALKP blob (sealed validly otherwise)", seal_alkp(prf1, seed, cred1, nonce1, magic=b"ALKR"))
    return cases


SCHEMA = v.case_schema(
    SUITE,
    "Passkey PRF wrap (04 §2.3) and owner seed blobs (04 §2.3.1 ALKP v1, §2.3.2 ALKR v1; D-82). "
    "`prfSalt`: the 32-byte PRF salt sha256(\"agentlink-owner-v1\"). `wrapKey`: HKDF-SHA256 of a "
    "32-byte PRF output with an empty salt and info \"owner-seed-wrap\", 32 bytes. `sealPasskey` / "
    "`sealRecovery`: the whole blob for a fixed nonce (and salt). `openPasskey` / `openRecovery`: the "
    "seed, or `outcome: reject`; an empty `expectedOwnerNostr` means the caller knows no expected owner. "
    "`passkeyHeader`: the public header fields of an ALKP blob. Hex without 0x; codes as text.",
    {
        "prfSalt": ({}, [{"salt": v.hexn(32)}]),
        "wrapKey": ({"prfOutput": v.hexn(32)}, [{"wrapKey": v.hexn(32)}]),
        "sealPasskey": ({"prfOutput": v.hexn(32), "seed": v.hexn(32), "credentialId": v.HEX, "nonce": v.hexn(12)}, [{"blob": v.HEX}]),
        "openPasskey": ({"blob": v.HEX, "prfOutput": v.HEX, "expectedOwnerNostr": v.HEX}, [{"seed": v.hexn(32)}, v.REJECT]),
        "passkeyHeader": ({"blob": v.HEX}, [{"ownerNostr": v.hexn(32), "credentialId": v.HEX}, v.REJECT]),
        "sealRecovery": ({"code": v.STRING, "seed": v.hexn(32), "salt": v.hexn(16), "nonce": v.hexn(12), "memoryKiB": v.INTEGER, "iterations": v.INTEGER, "parallelism": v.INTEGER}, [{"blob": v.HEX}]),
        "openRecovery": ({"blob": v.HEX, "code": v.STRING, "source": {"enum": ["prompt", "file"]}, "expectedOwnerNostr": v.HEX}, [{"seed": v.hexn(32)}, v.REJECT]),
    },
)

if __name__ == "__main__":
    v.main(
        suite=SUITE,
        version=VERSION,
        script="tools/vectors/generate_prf_wrap.py",
        libraries=["cryptography", "coincurve", "pycryptodome"],
        build=build,
        schema=SCHEMA,
        doc=__doc__,
    )
