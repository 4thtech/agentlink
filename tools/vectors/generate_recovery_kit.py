#!/usr/bin/env python3
"""Independent generator for the `recovery-kit` suite: the recovery kit `ALKK` v1 (M1-9i-b, D-115).

04 §2.3.3, exactly:
  header (74 B) = "ALKK" | u8 version=1 | u8 secretKind=1 | u8 kdf=1 | u32be m (KiB) | u8 t | u8 p
                  | salt (16) | u8 aead=2 | u32be chunkSize | noncePrefix (8) | ownerNostr (32)
  kek  = HKDF-SHA256(ikm = Argon2id(password(code, 1), salt, m, t, p, L = 32), salt = "",
                     info = "agentlink/v1/recovery-kit", L = 32)
  body = the 04 §4 STREAM construction under kek: chunk i is AES-256-GCM with nonce
         noncePrefix || u32be(i) and AAD header (74 B) || u8(isFinal); the ALF1 chunk rules (every
         chunk but the last holds exactly chunkSize bytes, the final one 1..chunkSize, no extra
         empty chunk; the empty plaintext is one empty final chunk).
  plaintext = entries `u16be nameLen | name (UTF-8) | u64be valueLen | value`, in this order:
         `manifest` (JCS JSON {"v":1,"kitId","createdAt","contents","ownerNostr",
         "agents":[{"agentId","name"}]}, agents sorted by agentId), `owner/seed` (32 B), then per
         agent in manifest order `agent/<agentId>/item/<name>` for name in seed, store-key,
         policy-version, receipts-kept, storage-mark (seed and store-key required, the others
         optional, always in this order), then `agent/<agentId>/store`.
Refused before the KDF: a header shorter than 74 bytes, a wrong magic, version != 1,
secretKind != 1, kdf != 1, aead != 2, chunkSize outside 1..16 MiB, KDF parameters outside the
04 §2.8 floor and cap (m 19456..262144 KiB, t 2..8, p 1..4), a header owner other than the expected
one, and a code that is not 24 base32 characters (04 §2.8 password kind 1). After the final chunk
authenticates: duplicate, unknown or out-of-order names, a missing required entry, a length
overflow, trailing bytes, a manifest that is not exactly the JCS form above, a manifest owner other
than the header's, an owner seed that does not derive ownerNostr (04 §2.1, x-only Nostr key at
epoch 0), an agent seed that does not derive its agentId (04 §2.9), and the caps: at most 16 agents,
every non-store value at most 64 KiB, each store at most 1 GiB, the whole kit at most 4 GiB.
The store snapshot is opaque to this format: its `identity.agent_id` and card checks belong to the
restore (M1-9i-c), which can read SQLite.

password() is the 04 §2.8 rule of generate_keystore_file.py; owner and agent keys are the 04 §2.1
derivation of generate_hkdf_derive.py; STREAM nonces, AAD and chunking are generate_stream.py's;
Argon2id, HKDF and AES-GCM are `cryptography`, JCS is `rfc8785`. A reference opener below must accept
every accept case and refuse every reject case before anything is written. Seeds, codes, salts,
nonce prefixes, store bytes and item values are synthetic test values (vectorlib.det).

`openWithKek` opens with the case's kek (the code path minus Argon2id), so the many entry-list cases
do not each pay for a KDF run; the header, code and KDF refusals go through `open` with the code.

Usage: python3 -I tools/vectors/generate_recovery_kit.py --check [FILE] | --write
"""

import base64
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import generate_hkdf_derive as hkdf  # noqa: E402
import generate_keystore_file as ksf  # noqa: E402
import generate_prf_wrap as prf  # noqa: E402
import generate_stream as st  # noqa: E402
import vectorlib as v  # noqa: E402

SUITE = "recovery-kit"
VERSION = 1
SPEC = "04 §2.3.3 ALKK v1"
INFO = b"agentlink/v1/recovery-kit"
MAGIC = b"ALKK"
HEADER_LEN = 74
TAG_LEN = 16
FLOOR = (19456, 2, 1)
DEFAULT = (65536, 3, 1)
MAX_CHUNK = 16 << 20
MAX_AGENTS = 16
MAX_ITEM = 64 << 10
MAX_STORE = 1 << 30
MAX_KIT = 4 << 30
ITEM_ORDER = ["seed", "store-key", "policy-version", "receipts-kept", "storage-mark"]
REQUIRED_ITEMS = {"seed", "store-key"}
KIT_ID = re.compile(r"[A-Za-z0-9_-]{22}")
AGENT_ID = re.compile(r"0x[0-9a-f]{40}")
AGENT_NAME = re.compile(r"[a-z][a-z0-9-]{0,31}")
OWNER_HEX = re.compile(r"[0-9a-f]{64}")


def u64be(n):
    return int(n).to_bytes(8, "big")


# --- reference implementation --------------------------------------------------------------------


def owner_nostr(seed):
    return v.xonly_public_key(hkdf.secp_secret(seed, hkdf.NOSTR, 0))


def header(salt, chunk_size, prefix, owner, m, t, p, magic=MAGIC, version=1, kind=1, kdf=1, aead=2):
    return (
        magic + v.u8(version) + v.u8(kind) + v.u8(kdf) + v.u32be(m) + v.u8(t) + v.u8(p) + salt
        + v.u8(aead) + v.u32be(chunk_size) + prefix + owner
    )


def kek(code, salt, m, t, p, info=INFO, source="prompt"):
    return v.hkdf_sha256(v.argon2id(ksf.password(code, 1, source), salt, m, t, p, 32), b"", info, 32)


def seal_body(key, head, prefix, chunk_size, plaintext, chunks=None):
    """STREAM body; `chunks` overrides the canonical chunking as (index, plaintext, isFinal) for
    the reorder and extra-chunk cases."""
    if chunks is None:
        parts = st.split(plaintext, chunk_size)
        chunks = [(i, c, i == len(parts) - 1) for i, c in enumerate(parts)]
    return b"".join(v.aes256gcm_encrypt(key, st.nonce(prefix, i), c, st.aad(head, f)) for i, c, f in chunks)


def entry(name, value):
    raw = name.encode("utf-8") if isinstance(name, str) else name
    return v.u16be(len(raw)) + raw + u64be(len(value)) + value


def manifest_bytes(kit_id, created_at, contents, owner, agents, **extra):
    doc = {"v": 1, "kitId": kit_id, "createdAt": created_at, "contents": contents, "ownerNostr": v.hx(owner), "agents": [{"agentId": a["agentId"], "name": a["name"]} for a in agents]}
    doc.update(extra)
    return v.jcs(doc)


def plaintext_of(manifest, owner_seed, agents):
    out = entry("manifest", manifest) + entry("owner/seed", owner_seed)
    for a in agents:
        for name, value in a["items"]:
            out += entry(f"agent/{a['agentId']}/item/{name}", value)
        out += entry(f"agent/{a['agentId']}/store", a["store"])
    return out


def check_header(data, expected_owner=None):
    if len(data) < HEADER_LEN or data[:4] != MAGIC:
        raise ValueError("not an ALKK header")
    if data[4] != 1 or data[5] != 1 or data[6] != 1 or data[29] != 2:
        raise ValueError("version, secretKind, kdf or aead")
    m, t, p = int.from_bytes(data[7:11], "big"), data[11], data[12]
    ksf.check_params(1, m, t, p)
    chunk_size = int.from_bytes(data[30:34], "big")
    if not 1 <= chunk_size <= MAX_CHUNK:
        raise ValueError("chunkSize outside 1..16 MiB")
    if expected_owner is not None and data[42:74] != expected_owner:
        raise ValueError("another owner")
    return {"m": m, "t": t, "p": p, "salt": data[13:29], "chunkSize": chunk_size, "prefix": data[34:42], "owner": data[42:74]}


def open_body(key, data, h):
    if len(data) > MAX_KIT:
        raise ValueError("kit above 4 GiB")
    head = data[:HEADER_LEN]
    body = data[HEADER_LEN:]
    if len(body) == 0:
        raise ValueError("no final chunk")
    step = h["chunkSize"] + TAG_LEN
    pieces = [body[i : i + step] for i in range(0, len(body), step)]
    if len(pieces[-1]) < TAG_LEN:
        raise ValueError("truncated final chunk")
    out = []
    for i, piece in enumerate(pieces):
        out.append(v.aes256gcm_decrypt(key, st.nonce(h["prefix"], i), piece, st.aad(head, i == len(pieces) - 1)))
    if len(out) > 1 and len(out[-1]) == 0:
        raise ValueError("empty final chunk after other chunks")
    return b"".join(out)


def parse_entries(plaintext):
    entries, i = [], 0
    while i < len(plaintext):
        if i + 2 > len(plaintext):
            raise ValueError("trailing bytes")
        n = int.from_bytes(plaintext[i : i + 2], "big")
        i += 2
        if i + n + 8 > len(plaintext):
            raise ValueError("name or length overflow")
        name = plaintext[i : i + n]
        i += n
        size = int.from_bytes(plaintext[i : i + 8], "big")
        i += 8
        if size > len(plaintext) - i:
            raise ValueError("value length overflow")
        entries.append((name, plaintext[i : i + size]))
        i += size
    return entries


def check_manifest(raw, owner):
    doc = json.loads(raw.decode("utf-8"))
    if v.jcs(doc) != raw:
        raise ValueError("manifest is not JCS")
    if not isinstance(doc, dict) or set(doc) != {"v", "kitId", "createdAt", "contents", "ownerNostr", "agents"}:
        raise ValueError("manifest keys")
    if type(doc["v"]) is not int or doc["v"] != 1:
        raise ValueError("manifest v")
    if not isinstance(doc["kitId"], str) or not KIT_ID.fullmatch(doc["kitId"]) or len(v.unb64u(doc["kitId"])) != 16:
        raise ValueError("kitId")
    if type(doc["createdAt"]) is not int or not 0 <= doc["createdAt"] <= 2**53 - 1:
        raise ValueError("createdAt")
    if doc["contents"] not in ("full", "identity"):
        raise ValueError("contents")
    if not isinstance(doc["ownerNostr"], str) or not OWNER_HEX.fullmatch(doc["ownerNostr"]) or doc["ownerNostr"] != v.hx(owner):
        raise ValueError("manifest owner")
    agents = doc["agents"]
    if not isinstance(agents, list) or len(agents) > MAX_AGENTS:
        raise ValueError("agents")
    ids = []
    for a in agents:
        if not isinstance(a, dict) or set(a) != {"agentId", "name"}:
            raise ValueError("agent keys")
        if not isinstance(a["agentId"], str) or not AGENT_ID.fullmatch(a["agentId"]):
            raise ValueError("agentId")
        if not isinstance(a["name"], str) or not AGENT_NAME.fullmatch(a["name"]):
            raise ValueError("agent name")
        ids.append(a["agentId"])
    if any(ids[k] >= ids[k + 1] for k in range(len(ids) - 1)):
        raise ValueError("agents not strictly sorted by agentId")
    return ids


def check_entries(entries, owner):
    """Entry names and order, caps, the manifest, and the seed checks. Returns the entries."""
    for name, value in entries:
        is_store = name.startswith(b"agent/") and name.endswith(b"/store")
        if len(value) > (MAX_STORE if is_store else MAX_ITEM):
            raise ValueError("entry above its cap")
    if len(entries) < 2 or entries[0][0] != b"manifest" or entries[1][0] != b"owner/seed":
        raise ValueError("manifest and owner/seed first")
    ids = check_manifest(entries[0][1], owner)
    owner_seed = entries[1][1]
    if len(owner_seed) != 32 or owner_nostr(owner_seed) != owner:
        raise ValueError("owner seed does not derive ownerNostr")
    k = 2
    for agent_id in ids:
        prefix = f"agent/{agent_id}/".encode("ascii")
        seen = []
        while True:
            if k >= len(entries):
                raise ValueError("missing store")
            name, value = entries[k]
            k += 1
            if name == prefix + b"store":
                break
            if not name.startswith(prefix + b"item/"):
                raise ValueError("unexpected entry")
            item = name[len(prefix) + 5 :].decode("ascii", "replace")
            if item not in ITEM_ORDER or (seen and ITEM_ORDER.index(item) <= ITEM_ORDER.index(seen[-1])):
                raise ValueError("unknown or out-of-order item")
            seen.append(item)
            if item == "seed" and (len(value) != 32 or ksf.agent_id_of(value) != agent_id):
                raise ValueError("agent seed does not derive agentId")
        if not REQUIRED_ITEMS <= set(seen):
            raise ValueError("missing required item")
    if k != len(entries):
        raise ValueError("entries after the last agent")
    return entries


def open_with_kek(data, key):
    h = check_header(data)
    return check_entries(parse_entries(open_body(key, data, h)), h["owner"])


def open_kit(data, code, expected_owner=None, source="prompt"):
    h = check_header(data, expected_owner)
    key = kek(code, h["salt"], h["m"], h["t"], h["p"], source=source)  # password() refuses first
    return check_entries(parse_entries(open_body(key, data, h)), h["owner"])


def refused(fn, *args):
    try:
        fn(*args)
    except Exception:
        return True
    return False


def flipped(data, offset, mask=0x01):
    out = bytearray(data)
    out[offset] ^= mask
    return bytes(out)


# --- fixtures ------------------------------------------------------------------------------------


def agent(label, name, items=("seed", "store-key"), store_len=40):
    seed = v.det(f"recovery-kit/agent/{label}/seed", 32)
    values = {
        "seed": seed,
        "store-key": v.det(f"recovery-kit/agent/{label}/store-key", 32),
        "policy-version": b"7",
        "receipts-kept": b"7",
        "storage-mark": v.jcs({"v": 1, "active": None}),
    }
    return {"agentId": ksf.agent_id_of(seed), "name": name, "items": [(n, values[n]) for n in ITEM_ORDER if n in items], "store": v.det(f"recovery-kit/agent/{label}/store", store_len)}


def code_of(label):
    return base64.b32encode(v.det(f"recovery-kit/code/{label}", 15)).decode("ascii")


def kit_id_of(label):
    return v.b64u(v.det(f"recovery-kit/kit-id/{label}", 16))


class Kit:
    """One sealed kit: its inputs (for `seal` cases) and bytes."""

    def __init__(self, label, owner_seed, agents, contents, chunk_size, params=FLOOR, created_at=1792540800, code=None, manifest=None, plaintext=None, info=INFO, **header_overrides):
        self.label = label
        self.code = code_of(label) if code is None else code
        self.salt = v.det(f"recovery-kit/{label}/salt", 16)
        self.prefix = v.det(f"recovery-kit/{label}/prefix", 8)
        self.chunk_size = chunk_size
        self.params = params
        self.owner_seed = owner_seed
        self.owner = owner_nostr(owner_seed)
        self.agents = sorted(agents, key=lambda a: a["agentId"])
        self.contents = contents
        self.kit_id = kit_id_of(label)
        self.created_at = created_at
        self.manifest = manifest_bytes(self.kit_id, created_at, contents, self.owner, self.agents) if manifest is None else manifest
        self.plaintext = plaintext_of(self.manifest, owner_seed, self.agents) if plaintext is None else plaintext
        self.kek = kek(self.code, self.salt, *params, info=info)
        self.head = header(self.salt, chunk_size, self.prefix, self.owner, *params, **header_overrides)
        self.body = seal_body(self.kek, self.head, self.prefix, chunk_size, self.plaintext)
        self.data = self.head + self.body

    def chunks(self):
        step = self.chunk_size + TAG_LEN
        return [self.body[i : i + step] for i in range(0, len(self.body), step)]

    def reseal(self, plaintext=None, chunks=None):
        """Same key and header, another plaintext or chunk layout."""
        pt = self.plaintext if plaintext is None else plaintext
        return self.head + seal_body(self.kek, self.head, self.prefix, self.chunk_size, pt, chunks)

    def seal_input(self):
        m, t, p = self.params
        return {
            "op": "seal",
            "code": self.code,
            "salt": v.hx(self.salt),
            "noncePrefix": v.hx(self.prefix),
            "chunkSize": self.chunk_size,
            "memoryKiB": m,
            "iterations": t,
            "parallelism": p,
            "ownerSeed": v.hx(self.owner_seed),
            "kitId": self.kit_id,
            "createdAt": self.created_at,
            "contents": self.contents,
            "agents": [{"agentId": a["agentId"], "name": a["name"], "items": [{"name": n, "value": v.hx(val)} for n, val in a["items"]], "store": v.hx(a["store"])} for a in self.agents],
        }


def opened(entries):
    names = [n.decode("ascii") for n, _ in entries]
    out = {"entryNames": ",".join(names)}
    for name, value in entries:
        out[f"entry:{name.decode('ascii')}"] = v.hx(value)
    return out


# --- cases ---------------------------------------------------------------------------------------


def build():
    owner_seed = v.det("recovery-kit/owner/seed", 32)
    other_owner_seed = v.det("recovery-kit/owner/other-seed", 32)
    a1 = agent("one", "default", items=ITEM_ORDER, store_len=48)
    a2 = agent("two", "research", items=("seed", "store-key", "receipts-kept"), store_len=37)
    a3 = agent("three", "default")
    cases = []

    # Accept kits --------------------------------------------------------------------------------
    single = Kit("one-chunk", owner_seed, [a3], "full", 4096)
    multi = Kit("multi-chunk", owner_seed, [a1], "full", 64)
    two = Kit("two-agents", owner_seed, [a1, a2], "identity", 64)
    # Several chunks with an exact last chunk: pad the second agent's store so the plaintext is a
    # multiple of the chunk size.
    pad = (-len(Kit("exact-chunks", owner_seed, [a1, a2], "full", 64).plaintext)) % 64
    a2x = dict(a2, store=v.det("recovery-kit/agent/two/store", 37 + pad))
    exact = Kit("exact-chunks", owner_seed, [a1, a2x], "full", 64)
    if len(exact.plaintext) % 64 != 0 or len(exact.chunks()) < 3 or len(exact.chunks()[-1]) != 64 + TAG_LEN:
        v.fail("exact-chunks: the plaintext is not an exact multiple of the chunk size")
    if len(single.chunks()) != 1 or len(multi.chunks()) < 3 or len(multi.plaintext) % 64 == 0:
        v.fail("chunk layout of the accept kits")
    accept = [
        (single, "one agent, one chunk (chunkSize 4096), a full manifest, the required items only"),
        (multi, "one agent, several chunks of 64 bytes with a short last chunk, all five items"),
        (two, "two agents (sorted by agentId), several chunks, an identity manifest"),
        (exact, "two agents, several chunks with an exact last chunk (no extra empty chunk)"),
    ]
    for kit, why in accept:
        entries = open_kit(kit.data, kit.code, kit.owner)
        if open_with_kek(kit.data, kit.kek) != entries or entries[1][1] != owner_seed:
            v.fail(f"{kit.label}: the reference opener disagrees")
        cases.append(v.case(f"kek-{kit.label}", f"{SPEC} kek = HKDF-SHA256(Argon2id(password(code, 1), salt, m, t, p, 32), \"\", \"agentlink/v1/recovery-kit\", 32) ({why})", kek_input(kit.code, kit.salt, kit.params), {"kek": v.hx(kit.kek)}))
        cases.append(v.case(f"seal-{kit.label}", f"{SPEC} seal: {why}", kit.seal_input(), {"kit": v.hx(kit.data), "kek": v.hx(kit.kek)}))
        cases.append(v.case(f"open-{kit.label}", f"{SPEC} open with the code and the expected owner: {why}", open_input(kit.data, kit.code, kit.owner), opened(entries)))
        cases.append(v.case(f"open-kek-{kit.label}", f"{SPEC} open with the kek: {why}", kek_open_input(kit.data, kit.kek), opened(entries)))
        m, t, p = kit.params
        cases.append(v.case(f"header-{kit.label}", f"{SPEC} header fields, read before the code is asked for: {why}", {"op": "header", "kit": v.hx(kit.data)}, {"ownerNostr": v.hx(kit.owner), "chunkSize": str(kit.chunk_size), "memoryKiB": str(m), "iterations": str(t), "parallelism": str(p)}))
    default_salt = v.det("recovery-kit/default/salt", 16)
    cases.append(v.case("kek-default-params", f"{SPEC} kek at the default parameters m = 64 MiB, t = 3, p = 1", kek_input(single.code, default_salt, DEFAULT), {"kek": v.hx(kek(single.code, default_salt, *DEFAULT))}))
    spelled = "-".join(multi.code[i : i + 4] for i in range(0, 24, 4)).lower()
    cases.append(v.case("open-code-spelled", f"{SPEC} open with the code in six lower-case groups of four with dashes (04 §2.8 password kind 1)", open_input(multi.data, spelled, None), opened(open_kit(multi.data, spelled))))
    cases.append(v.case("open-no-expected-owner", f"{SPEC} open with no expected owner; the owner seed still derives the header owner", open_input(single.data, single.code, None), opened(open_kit(single.data, single.code))))

    # Rejections through the code path --------------------------------------------------------------
    def reject(case_id, why, data, code=None, expected=None, source="prompt"):
        code = multi.code if code is None else code
        if not refused(open_kit, data, code, expected, source):
            v.fail(f"{case_id}: the reference opener accepts it")
        cases.append(v.case(f"open-reject-{case_id}", f"{SPEC}: {why}", open_input(data, code, expected, source), {"outcome": "reject"}))

    def reject_kek(case_id, why, data, key=None):
        key = multi.kek if key is None else key
        if not refused(open_with_kek, data, key):
            v.fail(f"{case_id}: the reference opener accepts it")
        cases.append(v.case(f"open-kek-reject-{case_id}", f"{SPEC}: {why}", kek_open_input(data, key), {"outcome": "reject"}))

    def reject_header(case_id, why, data):
        if not refused(check_header, data):
            v.fail(f"{case_id}: the reference header reader accepts it")
        cases.append(v.case(f"header-reject-{case_id}", f"{SPEC}: {why}", {"op": "header", "kit": v.hx(data)}, {"outcome": "reject"}))

    d = multi.data
    reject("wrong-code", "another recovery code (fails authentication)", d, code=code_of("other"))
    reject("mistyped-char", "a character outside the base32 alphabet, refused before the KDF", d, code=multi.code[:23] + "!")
    reject("23-chars", "23 characters, refused before the KDF", d, code=multi.code[:23])
    reject("other-owner", "the header owner is not the expected owner, refused before the KDF", d, expected=owner_nostr(other_owner_seed))
    for field, offset in [("magic", 0), ("version", 4), ("secret-kind", 5), ("kdf", 6), ("memory", 10), ("iterations", 11), ("salt", 13), ("aead", 29), ("chunk-size", 33), ("nonce-prefix", 34), ("owner", 42)]:
        reject(f"flip-{field}", f"one bit flipped in the header ({field}); refused before the KDF where the value leaves the format, otherwise by authentication", flipped(d, offset))
    reject("flip-body", "one bit flipped in the first chunk's ciphertext", flipped(d, HEADER_LEN + 3))
    reject("flip-tag", "one bit flipped in the final chunk's tag", flipped(d, len(d) - 1, 0x80))
    for case_id, why, kw in [
        ("version-0", "version 0 (sealed validly)", {"version": 0}),
        ("version-2", "version 2 (sealed validly)", {"version": 2}),
        ("secret-kind-2", "secretKind 2: a chosen passphrase never seals a kit (sealed validly)", {"kind": 2}),
        ("kdf-2", "kdf 2 (sealed validly)", {"kdf": 2}),
        ("aead-1", "aead 1, the single-shot value (sealed validly)", {"aead": 1}),
        ("aead-3", "aead 3 (sealed validly)", {"aead": 3}),
    ]:
        bad = Kit("multi-chunk", owner_seed, [a1], "full", 64, **kw)
        reject(case_id, f"{why}, refused before the KDF", bad.data)
        reject_header(case_id, f"{why}, refused by the header reader", bad.data)
    for case_id, why, chunk in [("chunk-size-0", "chunkSize 0", 0), ("chunk-size-16mib-plus-1", "chunkSize 16 MiB + 1", MAX_CHUNK + 1)]:
        bad = header(multi.salt, chunk, multi.prefix, multi.owner, *FLOOR) + multi.body
        reject(case_id, f"{why}, refused before the KDF", bad)
        reject_header(case_id, f"{why}, refused by the header reader", bad)
    for case_id, why, params in [
        ("m-below-floor", "m = 19455 KiB", (19455, 2, 1)),
        ("m-above-cap", "m = 262145 KiB", (262145, 2, 1)),
        ("t-1", "t = 1", (19456, 1, 1)),
        ("t-9", "t = 9", (19456, 9, 1)),
        ("p-0", "p = 0", (19456, 2, 0)),
        ("p-5", "p = 5", (19456, 2, 5)),
    ]:
        bad = header(multi.salt, 64, multi.prefix, multi.owner, *params) + multi.body
        reject(case_id, f"KDF parameters out of bounds ({why}), refused before the KDF runs", bad)
        reject_header(case_id, f"KDF parameters out of bounds ({why}), refused by the header reader", bad)
    reject_header("73-bytes", "a header one byte short", d[:73])
    reject_header("alkr-blob", "an ALKR blob", prf_blobs(owner_seed)["ALKR"])
    label_kit = Kit("multi-chunk", owner_seed, [a1], "full", 64, info=prf.RECOVERY_INFO)
    reject("alkr-label", "a kit sealed under the ALKR label agentlink/v1/owner-recovery-wrap", label_kit.data)

    # Rejections with the kek: STREAM ----------------------------------------------------------------
    c = multi.chunks()
    head = multi.head
    reject_kek("empty", "empty", b"")
    reject_kek("header-only", "the header without any chunk (missing final chunk)", head)
    reject_kek("truncated-byte", "one byte short", d[:-1])
    reject_kek("truncated-chunk", "truncated inside the final chunk, shorter than a tag", head + b"".join(c[:-1]) + c[-1][:15])
    reject_kek("missing-final", "the final chunk dropped: the last chunk present was sealed with isFinal 0", head + b"".join(c[:-1]))
    reject_kek("reordered", "chunks 0 and 1 swapped", head + c[1] + c[0] + b"".join(c[2:]))
    reject_kek("duplicated", "chunk 0 repeated in place of chunk 1", head + c[0] + c[0] + b"".join(c[2:]))
    parts = st.split(exact.plaintext, 64)
    extra = [(i, p, False) for i, p in enumerate(parts)] + [(len(parts), b"", True)]
    reject_kek("extra-empty-chunk", "an exact multiple sealed as full middle chunks and an extra empty final chunk", exact.reseal(chunks=extra), exact.kek)
    reject_kek("appended-byte", "one zero byte appended after the final chunk", d + b"\x00")
    reject_kek("appended-chunk", "a copy of chunk 0 appended after the final chunk", d + c[0])
    reject_kek("final-flag-on-middle", "chunk 1 sealed with isFinal 1", multi.reseal(chunks=[(i, p, i in (1, len(st.split(multi.plaintext, 64)) - 1)) for i, p in enumerate(st.split(multi.plaintext, 64))]))
    reject_kek("wrong-kek", "another kek", d, two.kek)
    reject_kek("alf1-header-aad", "chunks sealed with the ALF1 header as AAD instead of the ALKK header", head + seal_body(multi.kek, st.header(64, multi.prefix), multi.prefix, 64, multi.plaintext))
    big = 2**64 - 1

    # Rejections with the kek: entry list ------------------------------------------------------------
    m1 = multi.manifest
    s1 = owner_seed
    items1 = [(f"agent/{a1['agentId']}/item/{n}", val) for n, val in a1["items"]]
    store1 = (f"agent/{a1['agentId']}/store", a1["store"])

    def ents(*pairs):
        return b"".join(entry(n, val) for n, val in pairs)

    good = [("manifest", m1), ("owner/seed", s1), *items1, store1]
    if ents(*good) != multi.plaintext:
        v.fail("entry fixture")

    def entry_case(case_id, why, pairs=None, raw=None):
        pt = ents(*pairs) if raw is None else raw
        reject_kek(case_id, why, multi.reseal(plaintext=pt))

    entry_case("empty-plaintext", "an empty plaintext (one empty final chunk): no manifest", raw=b"")
    entry_case("duplicate-name", "the store-key item twice", [*good[:4], good[3], *good[4:]])
    entry_case("duplicate-manifest", "the manifest twice", [good[0], *good])
    entry_case("unknown-name", "an unknown entry name before the store", [*good[:-1], (f"agent/{a1['agentId']}/notes", b"x"), good[-1]])
    entry_case("unknown-item", "an item name outside the five allowed", [*good[:-1], (f"agent/{a1['agentId']}/item/cache", b"x"), good[-1]])
    entry_case("s3-item", "an s3:<id> item (storage credentials are never in a kit, D-115 D)", [*good[:-1], (f"agent/{a1['agentId']}/item/s3:0123456789abcdef", b"{}"), good[-1]])
    entry_case("item-order", "store-key before seed", [good[0], good[1], good[3], good[2], *good[4:]])
    entry_case("optional-order", "storage-mark before policy-version", [good[0], good[1], good[2], good[3], good[6], good[4], good[5], good[7]])
    entry_case("seed-and-manifest-swapped", "owner/seed before the manifest", [good[1], good[0], *good[2:]])
    entry_case("missing-owner-seed", "no owner/seed entry", [good[0], *good[2:]])
    entry_case("missing-seed", "no seed item", [good[0], good[1], *good[3:]])
    entry_case("missing-store-key", "no store-key item", [good[0], good[1], good[2], *good[4:]])
    entry_case("missing-store", "no store entry", good[:-1])
    entry_case("store-before-items", "the store before the items", [good[0], good[1], good[-1], *good[2:-1]])
    entry_case("extra-after-store", "an entry after the last agent's store", [*good, ("owner/seed", s1)])
    entry_case("agent-not-in-manifest", "entries for a second agent the manifest does not list", [*good, *[(f"agent/{a2['agentId']}/item/{n}", val) for n, val in a2["items"]], (f"agent/{a2['agentId']}/store", a2["store"])])
    m_two = manifest_bytes(multi.kit_id, multi.created_at, "full", multi.owner, sorted([a1, a2], key=lambda a: a["agentId"]))
    first, second = sorted([a1, a2], key=lambda a: a["agentId"])

    def agent_pairs(a):
        return [*[(f"agent/{a['agentId']}/item/{n}", val) for n, val in a["items"]], (f"agent/{a['agentId']}/store", a["store"])]

    entry_case("agents-out-of-manifest-order", "two agents' entries in the reverse of manifest order", [("manifest", m_two), ("owner/seed", s1), *agent_pairs(second), *agent_pairs(first)])
    entry_case("trailing-1-byte", "one byte after the last entry", raw=multi.plaintext + b"\x00")
    entry_case("trailing-name-length", "a name length with nothing after it", raw=multi.plaintext + v.u16be(8))
    entry_case("value-length-overflow", "a value length one more than the bytes left", raw=multi.plaintext[: -len(a1["store"]) - 8] + u64be(len(a1["store"]) + 1) + a1["store"])
    entry_case("value-length-max", "a value length of 2^64 - 1", raw=multi.plaintext[: -len(a1["store"]) - 8] + u64be(big) + a1["store"])
    entry_case("name-length-overflow", "a name length past the end", raw=ents(*good[:-1]) + v.u16be(500) + b"agent/")
    entry_case("owner-seed-31", "a 31-byte owner seed", [good[0], ("owner/seed", s1[:31]), *good[2:]])
    entry_case("owner-seed-other", "an owner seed that does not derive ownerNostr", [good[0], ("owner/seed", other_owner_seed), *good[2:]])
    other_agent_seed = v.det("recovery-kit/agent/other/seed", 32)
    entry_case("agent-seed-other", "an agent seed that does not derive its agentId", [good[0], good[1], (items1[0][0], other_agent_seed), *good[3:]])
    entry_case("agent-seed-33", "a 33-byte agent seed", [good[0], good[1], (items1[0][0], a1["items"][0][1] + b"\x00"), *good[3:]])
    entry_case("item-64kib-plus-1", "a non-store entry of 64 KiB + 1 bytes (the ALKS cap)", [*good[:-2], (good[-2][0], v.det("recovery-kit/big-item", MAX_ITEM + 1)), good[-1]])
    entry_case("store-1gib-plus-1", "a store whose value length is 1 GiB + 1 (above the store cap; the kit ends early)", raw=multi.plaintext[: -len(a1["store"]) - 8] + u64be(MAX_STORE + 1) + a1["store"])

    # Manifest -------------------------------------------------------------------------------------
    def man(**kw):
        doc = {"v": 1, "kitId": multi.kit_id, "createdAt": multi.created_at, "contents": "full", "ownerNostr": v.hx(multi.owner), "agents": [{"agentId": a1["agentId"], "name": a1["name"]}]}
        drop = kw.pop("_drop", None)
        doc.update(kw)
        if drop:
            del doc[drop]
        return v.jcs_lenient(doc)

    def man_case(case_id, why, raw):
        entry_case(f"manifest-{case_id}", f"manifest: {why}", [("manifest", raw), *good[1:]])

    man_case("whitespace", "not JCS (a space after a colon)", m1.replace(b'"v":1', b'"v": 1'))
    man_case("key-order", "not JCS (v first instead of in key order)", b'{"v":1,' + m1[1:].replace(b',"v":1}', b"}"))
    man_case("v-2", "v = 2", man(v=2))
    man_case("v-string", "v = \"1\"", man(v="1"))
    man_case("missing-kit-id", "no kitId", man(_drop="kitId"))
    man_case("extra-key", "an extra key", man(note="x"))
    man_case("kit-id-short", "kitId of 15 bytes", man(kitId=v.b64u(v.det("recovery-kit/kit-id/short", 15))))
    man_case("kit-id-padded", "kitId with padding", man(kitId=multi.kit_id + "=="))
    man_case("kit-id-noncanonical", "kitId with non-zero trailing bits", man(kitId=multi.kit_id[:21] + chr(ord(multi.kit_id[21]) + 1)))
    man_case("created-at-negative", "createdAt -1", man(createdAt=-1))
    man_case("created-at-2-53", "createdAt 2^53", man(createdAt=2**53))
    man_case("created-at-float", "createdAt 1.5", man(createdAt=1.5))
    man_case("created-at-string", "createdAt as a string", man(createdAt=str(multi.created_at)))
    man_case("contents-other", "contents \"all\"", man(contents="all"))
    man_case("owner-upper", "ownerNostr in upper case", man(ownerNostr=v.hx(multi.owner).upper()))
    man_case("owner-0x", "ownerNostr with a 0x prefix", man(ownerNostr="0x" + v.hx(multi.owner)))
    man_case("owner-other", "ownerNostr of another owner (header and manifest differ)", man(ownerNostr=v.hx(owner_nostr(other_owner_seed))))
    man_case("agent-id-upper", "an agentId in upper-case hex", man(agents=[{"agentId": "0x" + a1["agentId"][2:].upper(), "name": a1["name"]}]))
    man_case("agent-name-upper", "an agent name with an upper-case letter", man(agents=[{"agentId": a1["agentId"], "name": "Default"}]))
    man_case("agent-name-digit", "an agent name starting with a digit", man(agents=[{"agentId": a1["agentId"], "name": "1default"}]))
    man_case("agent-name-33", "an agent name of 33 characters", man(agents=[{"agentId": a1["agentId"], "name": "a" * 33}]))
    man_case("agent-extra-key", "an agent with an extra key", man(agents=[{"agentId": a1["agentId"], "name": a1["name"], "x": 1}]))
    man_case("agents-not-array", "agents is an object", man(agents={"agentId": a1["agentId"]}))
    man_case("not-json", "not JSON", b"{")
    man_case("not-utf8", "not UTF-8", b"\xff")
    entry_case("agents-unsorted", "two agents in the manifest not sorted by agentId (entries follow the manifest)", [("manifest", manifest_bytes(multi.kit_id, multi.created_at, "full", multi.owner, [second, first])), ("owner/seed", s1), *agent_pairs(second), *agent_pairs(first)])
    entry_case("agents-duplicate", "the same agent twice in the manifest", [("manifest", manifest_bytes(multi.kit_id, multi.created_at, "full", multi.owner, [a1, a1])), ("owner/seed", s1), *agent_pairs(a1), *agent_pairs(a1)])
    many = [agent(f"many/{k}", f"agent-{k}") for k in range(MAX_AGENTS + 1)]
    many.sort(key=lambda a: a["agentId"])
    many_pairs = [pair for a in many for pair in agent_pairs(a)]
    big_kit = Kit("many-agents", owner_seed, [], "full", 4096, plaintext=ents(("manifest", manifest_bytes(kit_id_of("many-agents"), 1792540800, "full", multi.owner, many)), ("owner/seed", s1), *many_pairs))
    reject_kek("17-agents", "17 agents (at most 16)", big_kit.data, big_kit.kek)
    sixteen = many[:MAX_AGENTS]
    ok16 = Kit("sixteen-agents", owner_seed, sixteen, "full", 4096)
    entries16 = open_with_kek(ok16.data, ok16.kek)
    cases.append(v.case("open-kek-sixteen-agents", f"{SPEC} open with the kek: 16 agents, the most a kit holds", kek_open_input(ok16.data, ok16.kek), opened(entries16)))

    # Cross-type ---------------------------------------------------------------------------------------
    blobs = prf_blobs(owner_seed)
    for name in ["ALKP", "ALKR", "ALKO", "ALKS", "ALF1"]:
        reject(f"{name.lower()}-blob", f"an {name} blob given to the ALKK reader, refused before the KDF", blobs[name])
    alkr_patched = b"ALKK" + blobs["ALKR"][4:]
    reject("alkr-magic-patched", "an ALKR blob with its magic rewritten to ALKK", alkr_patched)
    for name in ["ALKP", "ALKR", "ALKO", "ALKS", "ALF1"]:
        cases.append(v.case(f"cross-{name.lower()}-reader", f"{SPEC}: the {name} reader refuses an ALKK kit (D-115)", cross_input(name, single.data, single.code, owner_seed), {"outcome": "reject"}))
        patched = name.encode("ascii") + single.data[4:]
        cases.append(v.case(f"cross-{name.lower()}-reader-magic-patched", f"{SPEC}: the {name} reader refuses an ALKK kit whose magic is rewritten to {name}", cross_input(name, patched, single.code, owner_seed), {"outcome": "reject"}))
    return cases


def prf_blobs(owner_seed):
    """One blob of each other type under the same code or a synthetic key (04 §2.3.1, §2.3.2, §2.8, §4)."""
    code = code_of("multi-chunk")
    salt, nonce = v.det("recovery-kit/cross/salt", 16), v.det("recovery-kit/cross/nonce", 12)
    out = {
        "ALKP": prf.seal_alkp(v.det("recovery-kit/cross/prf", 32), owner_seed, v.det("recovery-kit/cross/cred", 16), nonce),
        "ALKR": prf.seal_alkr(code, owner_seed, salt, nonce, FLOOR),
        "ALF1": st.seal(v.det("recovery-kit/cross/file-key", 32), v.det("recovery-kit/cross/prefix", 8), 64, v.det("recovery-kit/cross/file", 100)),
    }
    alko_header = ksf.header(1, *FLOOR, salt, nonce, "", magic=b"ALKO")
    out["ALKO"] = alko_header + v.aes256gcm_encrypt(ksf.kek(code, 1, salt, *FLOOR, ksf.ALKO_INFO), nonce, owner_seed, alko_header)
    out["ALKS"] = ksf.seal(code, 1, *FLOOR, salt, nonce, ksf.agent_id_of(owner_seed), ksf.entries_bytes([("seed", owner_seed)]))
    return out


def kek_input(code, salt, params):
    m, t, p = params
    return {"op": "kek", "code": code, "salt": v.hx(salt), "memoryKiB": m, "iterations": t, "parallelism": p}


def open_input(data, code, expected, source="prompt"):
    return {"op": "open", "kit": v.hx(data), "code": code, "source": source, "expectedOwnerNostr": "" if expected is None else v.hx(expected)}


def kek_open_input(data, key):
    return {"op": "openWithKek", "kit": v.hx(data), "kek": v.hx(key)}


def cross_input(reader, data, code, owner_seed):
    keys = ksf.owner_keys(owner_seed)
    return {
        "op": "crossType",
        "reader": reader,
        "blob": v.hx(data),
        "code": code,
        "key": v.hx(v.det("recovery-kit/cross/key", 32)),
        "agentId": ksf.agent_id_of(owner_seed),
        "ownerEvm": keys["ownerEvm"],
        "ownerNostr": keys["ownerNostr"],
    }


ITEM = v.strict_object({"name": v.STRING, "value": v.HEX})
AGENT = v.strict_object({"agentId": v.ADDRESS, "name": v.STRING, "items": {"type": "array", "items": ITEM}, "store": v.HEX})
OPEN_OK = {"type": "object", "required": ["entryNames"], "properties": {"entryNames": v.STRING}, "patternProperties": {"^entry:": v.HEX}, "additionalProperties": False}
KDF = {"memoryKiB": v.INTEGER, "iterations": v.INTEGER, "parallelism": v.INTEGER}
DECIMAL = {"type": "string", "pattern": "^(0|[1-9][0-9]*)$"}
SCHEMA = v.case_schema(
    SUITE,
    "04 §2.3.3 recovery kit ALKK v1 (D-115). `kek`: the key-encryption key for a code, salt and "
    "KDF parameters. `seal`: the whole kit and its kek for a fixed code, salt, nonce prefix and chunk "
    "size, the owner seed, the manifest fields and per agent its items (in any order) and store. "
    "`open` (with the code; an empty `expectedOwnerNostr` means no expected owner) and `openWithKek`: "
    "entry names (comma-separated, in kit order) and each value as `entry:<name>` hex, or a rejection. "
    "`header`: the public header fields read before the code is asked for, or a rejection. "
    "`crossType`: another format's reader (ALKP with `key` as the PRF output, ALKR and ALKS and ALKO "
    "with `code`, ALF1 with `key` as the file key) given an ALKK kit, which it refuses. Hex without "
    "0x except agent and owner keys in the ALKO and ALKS inputs; codes as text.",
    {
        "kek": ({"code": v.STRING, "salt": v.hexn(16), **KDF}, [{"kek": v.hexn(32)}]),
        "seal": (
            {"code": v.STRING, "salt": v.hexn(16), "noncePrefix": v.hexn(8), "chunkSize": v.INTEGER, **KDF, "ownerSeed": v.hexn(32), "kitId": v.STRING, "createdAt": v.INTEGER, "contents": {"enum": ["full", "identity"]}, "agents": {"type": "array", "items": AGENT}},
            [{"kit": v.HEX, "kek": v.hexn(32)}],
        ),
        "open": ({"kit": v.HEX, "code": v.STRING, "source": {"enum": ["prompt", "file"]}, "expectedOwnerNostr": v.HEX}, [v.REJECT]),
        "openWithKek": ({"kit": v.HEX, "kek": v.hexn(32)}, [v.REJECT]),
        "header": ({"kit": v.HEX}, [{"ownerNostr": v.hexn(32), "chunkSize": DECIMAL, "memoryKiB": DECIMAL, "iterations": DECIMAL, "parallelism": DECIMAL}, v.REJECT]),
        "crossType": (
            {"reader": {"enum": ["ALKP", "ALKR", "ALKO", "ALKS", "ALF1"]}, "blob": v.HEX, "code": v.STRING, "key": v.hexn(32), "agentId": v.ADDRESS, "ownerEvm": v.ADDRESS, "ownerNostr": {"type": "string", "pattern": "^0x[0-9a-f]{64}$"}},
            [v.REJECT],
        ),
    },
)
# `open` and `openWithKek` succeed with a variable set of entry fields, which strict_object cannot express.
for _branch in SCHEMA["oneOf"]:
    if _branch["properties"]["input"]["properties"]["op"]["const"] in ("open", "openWithKek"):
        _branch["properties"]["expected"] = {"oneOf": [OPEN_OK, v.strict_object(v.REJECT)]}

if __name__ == "__main__":
    v.main(
        suite=SUITE,
        version=VERSION,
        script="tools/vectors/generate_recovery_kit.py",
        libraries=["cryptography", "coincurve", "pycryptodome", "rfc8785"],
        build=build,
        schema=SCHEMA,
        doc=__doc__,
    )
