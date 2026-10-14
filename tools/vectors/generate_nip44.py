#!/usr/bin/env python3
"""Independent generator for the `nip44` suite: NIP-44 v2 encryption (M1-1h; used by M1-1g).

Every case is from the official NIP-44 v2 test vectors (paulmillr/nip44, nip44.vectors.json,
commit 1f8dba1707d065b39329b75012a13a6d1d8124f5, SHA-256 below), committed under
tools/vectors/sources/. The generator recomputes every valid case with its own NIP-44 v2
composition (secp256k1 ECDH from libsecp256k1 via coincurve; HKDF, HMAC-SHA256 and ChaCha20 from
`cryptography`) and confirms that every invalid case is refused, so two independent sources agree
on each value. NIP-44 is the transport encryption of 04 §3.5 (NIP-59 seal and gift wrap).

Usage: python3 -I tools/vectors/generate_nip44.py --check [FILE] | --write
"""

import base64
import hashlib
import hmac
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import vectorlib as v  # noqa: E402

SUITE = "nip44"
VERSION = 1
SOURCE_FILE = "nip44.vectors.json"
SOURCE_SHA256 = "269ed0f69e4c192512cc779e78c555090cebc7c785b609e338a62afc3ce25040"
SOURCE = "NIP-44 v2 official vectors (paulmillr/nip44@1f8dba17)"


# --- NIP-44 v2 (https://github.com/nostr-protocol/nips/blob/master/44.md) -------------------------


def conversation_key(sec1, pub2):
    from coincurve import PrivateKey, PublicKey

    if not 0 < int.from_bytes(sec1, "big") < v.SECP256K1_N:
        raise ValueError("invalid secret key")
    shared = PublicKey(b"\x02" + pub2).multiply(PrivateKey(sec1).secret).format(compressed=True)[1:]
    return v.hmac_sha256(b"nip44-v2", shared)  # HKDF-extract(salt = "nip44-v2", ikm = shared x)


def message_keys(conv_key, nonce):
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.kdf.hkdf import HKDFExpand

    keys = HKDFExpand(algorithm=hashes.SHA256(), length=76, info=nonce).derive(conv_key)
    return keys[0:32], keys[32:44], keys[44:76]


def padded_length(n):
    if n <= 32:
        return 32
    next_power = 1 << (math.floor(math.log2(n - 1)) + 1)
    chunk = 32 if next_power <= 256 else next_power // 8
    return chunk * ((n - 1) // chunk + 1)


def chacha20(key, nonce12, data):
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms

    return Cipher(algorithms.ChaCha20(key, b"\x00" * 4 + nonce12), mode=None).encryptor().update(data)


def encrypt(conv_key, nonce, plaintext):
    raw = plaintext.encode("utf-8")
    if not 1 <= len(raw) <= 65535:
        raise ValueError("invalid plaintext length")
    padded = v.u16be(len(raw)) + raw + bytes(padded_length(len(raw)) - len(raw))
    chacha_key, chacha_nonce, hmac_key = message_keys(conv_key, nonce)
    ciphertext = chacha20(chacha_key, chacha_nonce, padded)
    mac = v.hmac_sha256(hmac_key, nonce + ciphertext)
    return base64.b64encode(b"\x02" + nonce + ciphertext + mac).decode("ascii")


def decrypt(conv_key, payload):
    if not payload or payload[0] == "#":
        raise ValueError("unknown version")
    if not 132 <= len(payload) <= 87472:
        raise ValueError("invalid payload size")
    data = base64.b64decode(payload, validate=True)
    if not 99 <= len(data) <= 65603 or data[0] != 2:
        raise ValueError("invalid data")
    nonce, ciphertext, mac = data[1:33], data[33:-32], data[-32:]
    chacha_key, chacha_nonce, hmac_key = message_keys(conv_key, nonce)
    if not hmac.compare_digest(v.hmac_sha256(hmac_key, nonce + ciphertext), mac):
        raise ValueError("invalid MAC")
    padded = chacha20(chacha_key, chacha_nonce, ciphertext)
    length = int.from_bytes(padded[:2], "big")
    if not 1 <= length <= 65535 or len(padded) != 2 + padded_length(length) or any(padded[2 + length :]):
        raise ValueError("invalid padding")
    return padded[2 : 2 + length].decode("utf-8")


def refused(fn, *args):
    try:
        fn(*args)
    except Exception:
        return True
    return False


def build():
    data = json.loads(v.read_source(SOURCE_FILE, SOURCE_SHA256))["v2"]
    valid, invalid = data["valid"], data["invalid"]
    cases = []

    for i, c in enumerate(valid["get_conversation_key"]):
        if conversation_key(v.unhex(c["sec1"]), v.unhex(c["pub2"])).hex() != c["conversation_key"]:
            v.fail(f"conversation key {i} differs")
        note = f" ({c['note']})" if c.get("note") else ""
        cases.append(v.case(f"conversation-key-{i}", f"{SOURCE} valid.get_conversation_key[{i}]{note}", {"op": "conversationKey", "sec1": c["sec1"], "pub2": c["pub2"]}, {"conversationKey": c["conversation_key"]}))

    mk = valid["get_message_keys"]
    for i, c in enumerate(mk["keys"]):
        keys = message_keys(v.unhex(mk["conversation_key"]), v.unhex(c["nonce"]))
        if [k.hex() for k in keys] != [c["chacha_key"], c["chacha_nonce"], c["hmac_key"]]:
            v.fail(f"message keys {i} differ")
        cases.append(
            v.case(
                f"message-keys-{i}",
                f"{SOURCE} valid.get_message_keys.keys[{i}]",
                {"op": "messageKeys", "conversationKey": mk["conversation_key"], "nonce": c["nonce"]},
                {"chachaKey": c["chacha_key"], "chachaNonce": c["chacha_nonce"], "hmacKey": c["hmac_key"]},
            )
        )

    for i, (length, padded) in enumerate(valid["calc_padded_len"]):
        if padded_length(length) != padded:
            v.fail(f"padded length {length} differs")
        cases.append(v.case(f"padded-length-{i}", f"{SOURCE} valid.calc_padded_len[{i}]", {"op": "paddedLength", "length": length}, {"paddedLength": str(padded)}))

    for i, c in enumerate(valid["encrypt_decrypt"]):
        conv = v.unhex(c["conversation_key"])
        pub2 = v.xonly_public_key(v.unhex(c["sec2"]))
        if conversation_key(v.unhex(c["sec1"]), pub2) != conv:
            v.fail(f"encrypt_decrypt {i}: conversation key differs")
        if encrypt(conv, v.unhex(c["nonce"]), c["plaintext"]) != c["payload"] or decrypt(conv, c["payload"]) != c["plaintext"]:
            v.fail(f"encrypt_decrypt {i} differs")
        source = f"{SOURCE} valid.encrypt_decrypt[{i}]"
        cases.append(v.case(f"encrypt-{i}", source, {"op": "encrypt", "conversationKey": c["conversation_key"], "nonce": c["nonce"], "plaintext": c["plaintext"]}, {"payload": c["payload"]}))
        cases.append(v.case(f"decrypt-{i}", source, {"op": "decrypt", "conversationKey": c["conversation_key"], "payload": c["payload"]}, {"plaintext": c["plaintext"]}))

    for i, c in enumerate(valid["encrypt_decrypt_long_msg"]):
        plaintext = c["pattern"] * c["repeat"]
        payload = encrypt(v.unhex(c["conversation_key"]), v.unhex(c["nonce"]), plaintext)
        if hashlib.sha256(plaintext.encode()).hexdigest() != c["plaintext_sha256"] or hashlib.sha256(payload.encode()).hexdigest() != c["payload_sha256"]:
            v.fail(f"long message {i} differs")
        cases.append(
            v.case(
                f"encrypt-long-{i}",
                f"{SOURCE} valid.encrypt_decrypt_long_msg[{i}]",
                {"op": "encryptLong", "conversationKey": c["conversation_key"], "nonce": c["nonce"], "pattern": c["pattern"], "repeat": c["repeat"]},
                {"plaintextSha256": c["plaintext_sha256"], "payloadSha256": c["payload_sha256"]},
            )
        )

    for i, length in enumerate(invalid["encrypt_msg_lengths"]):
        if not refused(encrypt, bytes(32), bytes(32), "a" * length):
            v.fail(f"length {length} accepted")
        cases.append(v.case(f"encrypt-reject-length-{i}", f"{SOURCE} invalid.encrypt_msg_lengths[{i}] (plaintext of {length} bytes)", {"op": "encryptLength", "length": length}, {"outcome": "reject"}))

    for i, c in enumerate(invalid["get_conversation_key"]):
        if not refused(conversation_key, v.unhex(c["sec1"]), v.unhex(c["pub2"])):
            v.fail(f"invalid conversation key {i} accepted")
        cases.append(v.case(f"conversation-key-reject-{i}", f"{SOURCE} invalid.get_conversation_key[{i}] ({c['note']})", {"op": "conversationKey", "sec1": c["sec1"], "pub2": c["pub2"]}, {"outcome": "reject"}))

    for i, c in enumerate(invalid["decrypt"]):
        if not refused(decrypt, v.unhex(c["conversation_key"]), c["payload"]):
            v.fail(f"invalid decrypt {i} accepted")
        cases.append(v.case(f"decrypt-reject-{i}", f"{SOURCE} invalid.decrypt[{i}] ({c['note']})", {"op": "decrypt", "conversationKey": c["conversation_key"], "payload": c["payload"]}, {"outcome": "reject"}))
    return cases


SCHEMA = v.case_schema(
    SUITE,
    "NIP-44 v2, official vectors. Keys and nonces hex; plaintexts UTF-8 text; payloads base64.",
    {
        "conversationKey": ({"sec1": v.HEX, "pub2": v.HEX}, [{"conversationKey": v.hexn(32)}, v.REJECT]),
        "messageKeys": ({"conversationKey": v.hexn(32), "nonce": v.hexn(32)}, [{"chachaKey": v.hexn(32), "chachaNonce": v.hexn(12), "hmacKey": v.hexn(32)}]),
        "paddedLength": ({"length": v.INTEGER}, [{"paddedLength": v.STRING}]),
        "encrypt": ({"conversationKey": v.hexn(32), "nonce": v.hexn(32), "plaintext": v.STRING}, [{"payload": v.STRING}]),
        "decrypt": ({"conversationKey": v.hexn(32), "payload": v.STRING}, [{"plaintext": v.STRING}, v.REJECT]),
        "encryptLong": (
            {"conversationKey": v.hexn(32), "nonce": v.hexn(32), "pattern": v.STRING, "repeat": v.INTEGER},
            [{"plaintextSha256": v.hexn(32), "payloadSha256": v.hexn(32)}],
        ),
        "encryptLength": ({"length": v.INTEGER}, [v.REJECT]),
    },
)

if __name__ == "__main__":
    v.main(
        suite=SUITE,
        version=VERSION,
        script="tools/vectors/generate_nip44.py",
        libraries=["cryptography", "coincurve"],
        build=build,
        schema=SCHEMA,
        doc=__doc__,
    )
