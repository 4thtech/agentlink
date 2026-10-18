#!/usr/bin/env python3
"""Independent generator for the `stream` suite: ALF1 STREAM file encryption (04 §4, D-80; the
code under test is M1-1d).

Object layout (04 §4): header = magic "ALF1" (4 B) | version u8 | chunkSize u32be |
noncePrefix (8 B), 17 bytes, followed by the chunks. Chunk i is AES-256-GCM under the file key with
nonce noncePrefix || u32be(i) and AAD header (17 B) || u8(isFinal), so a modified header, a
reordered chunk or a missing final chunk fails decryption (STREAM construction, D-80). Each chunk
is its ciphertext followed by its 16-byte tag. `ciphertextSha256` is SHA-256 over the whole object
(header included) and `plaintextSha256` over the file bytes (04 §4 Integrity).

Rules 04 §4 states as proposed (owner confirms at merge), and this generator follows:
- The version byte is 0x01; any other value is rejected.
- Chunking: the plaintext is split into chunks of exactly chunkSize bytes, the last one (the only
  chunk with isFinal = 1) holding the remaining 1..chunkSize bytes. An empty file is one empty
  final chunk, so its object is 17 + 16 = 33 bytes. A plaintext of an exact multiple of chunkSize
  ends with a full final chunk, never an extra empty one; an empty final chunk after other chunks
  is not canonical and is rejected. This agrees with the 04 §3.4 inline cap: 12 255 bytes of file
  content are 12 288 bytes of ALF1 ciphertext (17 + 12 255 + 16) at the default 1 MiB chunk size.
- A decoder reads chunkSize from the header and splits the body into pieces of chunkSize + 16
  bytes; the last piece (16..chunkSize + 16 bytes) is the final chunk.
- Senders use chunkSize 1 MiB; recipients accept 1 <= chunkSize <= 16 MiB and reject any other
  value before decrypting. The seal cases also use 16 and 32 bytes (through the implementation's
  test seam) to reach the chunk boundaries cheaply, and 16 MiB once, at the recipients' bound.

`cryptography`'s AES-GCM is cross-checked against the published AES-256 test case 16 of McGrew and
Viega, "The Galois/Counter Mode of Operation (GCM)" (the NIST GCM submission), before anything is
written. A reference decoder in this script must accept every positive case and refuse every
rejection. The file keys and nonce prefixes are synthetic test values (vectorlib.det).

Usage: python3 -I tools/vectors/generate_stream.py --check [FILE] | --write
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import vectorlib as v  # noqa: E402

SUITE = "stream"
VERSION = 1

MAGIC = b"ALF1"
FORMAT_VERSION = 1
HEADER_LEN = 17
TAG_LEN = 16
DEFAULT_CHUNK = 1 << 20
MAX_CHUNK = 16 << 20
INLINE_CAP = 12255
SPEC = "04 §4 ALF1 STREAM (D-80): nonce noncePrefix || u32be(index), AAD header (17 B) || u8(isFinal)"

# McGrew and Viega, GCM specification, Appendix B, Test Case 16 (AES-256, 96-bit IV, AAD).
GCM_TC16 = {
    "k": "feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308",
    "p": "d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a72"
    "1c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39",
    "a": "feedfacedeadbeeffeedfacedeadbeefabaddad2",
    "iv": "cafebabefacedbaddecaf888",
    "c": "522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa"
    "8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f662",
    "t": "76fc6ece0f4e1768cddf8853bb2d551b",
}


def self_check():
    tc = GCM_TC16
    out = v.aes256gcm_encrypt(v.unhex(tc["k"]), v.unhex(tc["iv"]), v.unhex(tc["p"]), v.unhex(tc["a"]))
    if out.hex() != tc["c"] + tc["t"]:
        v.fail("AES-256-GCM disagrees with GCM test case 16")
    if v.aes256gcm_decrypt(v.unhex(tc["k"]), v.unhex(tc["iv"]), out, v.unhex(tc["a"])).hex() != tc["p"]:
        v.fail("AES-256-GCM decryption disagrees with GCM test case 16")


# --- the format ----------------------------------------------------------------------------------


def header(chunk_size, prefix, magic=MAGIC, version=FORMAT_VERSION):
    return bytes(magic) + v.u8(version) + v.u32be(chunk_size) + bytes(prefix)


def nonce(prefix, index):
    return bytes(prefix) + v.u32be(index)


def aad(head, is_final):
    return bytes(head) + v.u8(1 if is_final else 0)


def split(plaintext, chunk_size):
    """The canonical chunking: full chunks, then a final chunk of 1..chunkSize bytes; an empty
    file is one empty final chunk."""
    if len(plaintext) == 0:
        return [b""]
    return [plaintext[i : i + chunk_size] for i in range(0, len(plaintext), chunk_size)]


def seal_chunk(file_key, prefix, head, index, chunk, is_final):
    return v.aes256gcm_encrypt(file_key, nonce(prefix, index), chunk, aad(head, is_final))


def seal(file_key, prefix, chunk_size, plaintext):
    head = header(chunk_size, prefix)
    chunks = split(plaintext, chunk_size)
    body = b"".join(
        seal_chunk(file_key, prefix, head, i, c, i == len(chunks) - 1) for i, c in enumerate(chunks)
    )
    return head + body


def open_object(file_key, data):
    """Reference decoder. Raises ValueError for anything but a canonical ALF1 object whose every
    chunk authenticates."""
    data = bytes(data)
    if len(data) < HEADER_LEN:
        raise ValueError("short header")
    head = data[:HEADER_LEN]
    if head[:4] != MAGIC:
        raise ValueError("bad magic")
    if head[4] != FORMAT_VERSION:
        raise ValueError("unknown version")
    chunk_size = int.from_bytes(head[5:9], "big")
    if not 1 <= chunk_size <= MAX_CHUNK:
        raise ValueError("chunkSize outside 1..16 MiB")
    prefix = head[9:17]
    body = data[HEADER_LEN:]
    if len(body) == 0:
        raise ValueError("no final chunk")
    step = chunk_size + TAG_LEN
    pieces = [body[i : i + step] for i in range(0, len(body), step)]
    if len(pieces[-1]) < TAG_LEN:
        raise ValueError("truncated final chunk")
    if len(pieces) > 2**32:
        raise ValueError("too many chunks")
    out = []
    for i, piece in enumerate(pieces):
        is_final = i == len(pieces) - 1
        try:
            out.append(v.aes256gcm_decrypt(file_key, nonce(prefix, i), piece, aad(head, is_final)))
        except Exception as error:  # cryptography raises InvalidTag
            raise ValueError(f"chunk {i} does not authenticate") from error
    if len(out) > 1 and len(out[-1]) == 0:
        raise ValueError("empty final chunk after other chunks")
    return b"".join(out)


# --- cases ---------------------------------------------------------------------------------------


def fk(label):
    return v.det(f"stream/{label}/file", 32)


def prefix_of(label):
    return v.det(f"stream/{label}/prefix", 8)


def plain(label, length):
    return v.det(f"stream/{label}/plaintext", length)


def seal_case(case_id, why, label, chunk_size, plaintext, file_key=None, prefix=None):
    file_key = fk(label) if file_key is None else file_key
    prefix = prefix_of(label) if prefix is None else prefix
    data = seal(file_key, prefix, chunk_size, plaintext)
    if open_object(file_key, data) != plaintext:
        v.fail(f"{case_id}: the reference decoder does not return the plaintext")
    chunks = len(split(plaintext, chunk_size))
    if len(data) != HEADER_LEN + len(plaintext) + TAG_LEN * chunks:
        v.fail(f"{case_id}: unexpected object length")
    return v.case(
        case_id,
        f"{SPEC}; {why}",
        {
            "op": "seal",
            "fileKey": file_key.hex(),
            "noncePrefix": prefix.hex(),
            "chunkSize": chunk_size,
            "plaintext": plaintext.hex(),
        },
        {
            "header": data[:HEADER_LEN].hex(),
            "ciphertext": data.hex(),
            "ciphertextSha256": v.sha256(data).hex(),
            "plaintextSha256": v.sha256(plaintext).hex(),
        },
    )


def reject_case(case_id, why, file_key, data):
    try:
        open_object(file_key, data)
        v.fail(f"{case_id}: the reference decoder accepts a rejection case")
    except ValueError:
        pass
    return v.case(
        f"reject-{case_id}",
        f"{SPEC}; {why}; rejected",
        {"op": "open", "fileKey": file_key.hex(), "ciphertext": bytes(data).hex()},
        {"outcome": "reject"},
    )


def build():
    self_check()
    cases = []

    small = 32
    cases += [
        seal_case("empty", "an empty file is one empty final chunk (17 + 16 bytes)", "empty", small, b""),
        seal_case("one-byte", "a 1-byte file: one final chunk", "one-byte", small, plain("one-byte", 1)),
        seal_case("exactly-one-chunk", "exactly chunkSize bytes: one full final chunk, no empty chunk after it", "one-chunk", small, plain("one-chunk", small)),
        seal_case("chunk-plus-one", "chunkSize + 1 bytes: a full chunk (isFinal 0), then a 1-byte final chunk", "chunk-plus-one", small, plain("chunk-plus-one", small + 1)),
        seal_case("multi-chunk", "100 bytes at chunkSize 32: chunks of 32, 32, 32 and a final 4", "multi", small, plain("multi", 100)),
        seal_case("exact-multiple", "3 x chunkSize bytes: three full chunks, the third final, no empty chunk after it", "exact-multiple", small, plain("exact-multiple", 3 * small)),
        seal_case("chunk-index-past-255", "4 200 bytes at chunkSize 16: 263 chunks, so u32be(index) reaches 0x00000106", "index-wide", 16, plain("index-wide", 4200)),
        seal_case("default-chunk-one-byte", "a 1-byte file at the default chunkSize of 1 MiB (header 0x00100000)", "default-small", DEFAULT_CHUNK, plain("default-small", 1)),
        seal_case("max-chunk-size-one-byte", "a 1-byte file at chunkSize 16 MiB, the largest a recipient accepts (header 0x01000000)", "max-chunk", MAX_CHUNK, plain("max-chunk", 1)),
        seal_case("default-chunk-inline-cap", "the 04 §3.4 inline cap: 12 255 bytes at the default 1 MiB give 12 288 bytes of ciphertext", "inline-cap", DEFAULT_CHUNK, plain("inline-cap", INLINE_CAP)),
    ]
    multi_plain = plain("multi", 100)
    cases.append(seal_case("multi-chunk-other-prefix", "the multi-chunk plaintext and file key under another nonce prefix: every chunk changes", "multi", small, multi_plain, prefix=prefix_of("multi-other")))
    cases.append(seal_case("multi-chunk-other-file-key", "the multi-chunk plaintext and nonce prefix under another file key", "multi", small, multi_plain, file_key=fk("multi-other")))
    if len({c["expected"]["ciphertext"] for c in cases}) != len(cases):
        v.fail("two seal cases have the same ciphertext")
    inline = next(c for c in cases if c["id"] == "default-chunk-inline-cap")
    if len(inline["expected"]["ciphertext"]) // 2 != 12288:
        v.fail("the inline cap does not give 12 288 bytes of ciphertext")

    # Rejections, from the multi-chunk object: 100 bytes at chunkSize 32 (four chunks, the last 4 B).
    key, prefix = fk("multi"), prefix_of("multi")
    head = header(small, prefix)
    good = seal(key, prefix, small, multi_plain)
    step = small + TAG_LEN
    body = good[HEADER_LEN:]
    c0, c1, c2, c3 = body[:step], body[step : 2 * step], body[2 * step : 3 * step], body[3 * step :]
    if c0 + c1 + c2 + c3 != body or len(c3) != 4 + TAG_LEN:
        v.fail("unexpected multi-chunk layout")
    chunks = split(multi_plain, small)

    def flip(data, index, bit=0x01):
        out = bytearray(data)
        out[index] ^= bit
        return bytes(out)

    def custom(seal_one, head_=head):
        """Chunks sealed one by one; seal_one(i, chunk) -> (index used in the nonce, isFinal)."""
        parts = []
        for i, chunk in enumerate(chunks):
            index, is_final = seal_one(i, chunk)
            parts.append(seal_chunk(key, prefix, head_, index, chunk, is_final))
        return head_ + b"".join(parts)

    last = len(chunks) - 1
    pre_d80 = head + b"".join(
        v.aes256gcm_encrypt(key, nonce(prefix, i), c, v.u8(1 if i == last else 0)) for i, c in enumerate(chunks)
    )
    other_file = seal(key, prefix_of("multi-other"), small, multi_plain)
    exact = seal(fk("exact-multiple"), prefix_of("exact-multiple"), small, plain("exact-multiple", 3 * small))
    exact_head = exact[:HEADER_LEN]
    empty_trailer = exact[:HEADER_LEN] + b"".join(
        seal_chunk(fk("exact-multiple"), prefix_of("exact-multiple"), exact_head, i, c, False)
        for i, c in enumerate(split(plain("exact-multiple", 3 * small), small))
    ) + seal_chunk(fk("exact-multiple"), prefix_of("exact-multiple"), exact_head, 3, b"", True)
    over = seal(fk("over-max"), prefix_of("over-max"), MAX_CHUNK + 1, plain("over-max", 1))
    over_head = over[:HEADER_LEN]
    if v.aes256gcm_decrypt(fk("over-max"), nonce(prefix_of("over-max"), 0), over[HEADER_LEN:], aad(over_head, True)) != plain("over-max", 1):
        v.fail("the over-maximum chunkSize object does not authenticate on its own")
    empty_obj = seal(fk("empty"), prefix_of("empty"), small, b"")
    empty_head = empty_obj[:HEADER_LEN]
    empty_not_final = empty_head + seal_chunk(fk("empty"), prefix_of("empty"), empty_head, 0, b"", False)

    rejections = [
        ("header-magic", "the magic changed to \"ALF2\" (the chunks are unchanged)", key, b"ALF2" + good[4:]),
        ("header-version", "the version byte changed from 1 to 2", key, good[:4] + v.u8(2) + good[5:]),
        ("header-chunk-size", "chunkSize changed from 32 to 48: the body splits differently and no chunk authenticates", key, good[:5] + v.u32be(48) + good[9:]),
        ("header-chunk-size-zero", "chunkSize 0", key, good[:5] + v.u32be(0) + good[9:]),
        ("header-chunk-size-over-max", "chunkSize 16 MiB + 1 on an otherwise valid object (its single chunk authenticates): above the recipients' bound", fk("over-max"), over),
        ("header-nonce-prefix", "one bit of the header's noncePrefix flipped (wrong nonce prefix and wrong AAD)", key, flip(good, 9)),
        ("header-short", "only the first 16 header bytes", key, good[:16]),
        ("header-only", "the header without any chunk (missing final chunk)", key, head),
        ("chunk-reorder", "chunks 0 and 1 swapped", key, head + c1 + c0 + c2 + c3),
        ("chunk-duplicate", "chunk 0 repeated in place of chunk 1", key, head + c0 + c0 + c2 + c3),
        ("chunk-dropped-middle", "chunk 1 dropped", key, head + c0 + c2 + c3),
        ("truncated-missing-final", "the final chunk dropped: chunk 2, sealed with isFinal 0, comes last", key, head + c0 + c1 + c2),
        ("truncated-final-bytes", "the last byte of the final chunk's tag removed", key, good[:-1]),
        ("truncated-final-short", "the final chunk cut to 15 bytes (shorter than a tag)", key, head + c0 + c1 + c2 + c3[:15]),
        ("appended-chunk", "a copy of chunk 0 appended after the final chunk", key, good + c0),
        ("appended-byte", "one zero byte appended after the final chunk", key, good + b"\x00"),
        ("final-flag-on-middle", "chunk 1 sealed with isFinal 1 (a truncation point inside the file)", key, custom(lambda i, c: (i, i in (1, last)))),
        ("final-flag-missing", "every chunk sealed with isFinal 0, the last one included", key, custom(lambda i, c: (i, False))),
        ("final-flag-on-all", "every chunk sealed with isFinal 1", key, custom(lambda i, c: (i, True))),
        ("nonce-index-from-one", "chunk nonces counted from 1 instead of 0", key, custom(lambda i, c: (i + 1, i == last))),
        ("nonce-index-little-endian", "the chunk index in the nonce as u32le instead of u32be", key, custom(lambda i, c: (int.from_bytes(v.u32be(i)[::-1], "big"), i == last))),
        ("nonce-prefix-mismatch", "chunks sealed under another nonce prefix than the header's", key, head + other_file[HEADER_LEN:]),
        ("spliced-chunk", "chunk 1 taken from the same file sealed under another nonce prefix", key, head + c0 + other_file[HEADER_LEN + step : HEADER_LEN + 2 * step] + c2 + c3),
        ("aad-pre-d80", "chunks sealed with the pre-D-80 AAD u8(isFinal) only, without the header", key, pre_d80),
        ("chunk-bit-flip", "one bit of chunk 1's ciphertext flipped", key, flip(good, HEADER_LEN + step + 3)),
        ("tag-bit-flip", "one bit of the final chunk's tag flipped", key, flip(good, len(good) - 1, 0x80)),
        ("wrong-file-key", "the object opened with another file key", fk("multi-other"), good),
        ("empty-final-after-full", "three full chunks with isFinal 0 and an empty final chunk (not the canonical chunking)", fk("exact-multiple"), empty_trailer),
        ("empty-file-not-final", "the empty file's single empty chunk sealed with isFinal 0", fk("empty"), empty_not_final),
        ("empty-file-header-only", "the empty file's header without its empty final chunk", fk("empty"), empty_head),
    ]
    for case_id, why, file_key, data in rejections:
        cases.append(reject_case(case_id, why, file_key, data))
    return cases


HEX32 = v.hexn(32)
SCHEMA = v.case_schema(
    SUITE,
    "ALF1 STREAM file encryption (04 §4, D-80). `seal`: the object (header || chunks, hex) for a "
    "file key, nonce prefix, chunk size (1 to 16 MiB) and plaintext, its 17-byte header, and the SHA-256 of the "
    "object and of the plaintext; decrypting the object must return the plaintext. `open`: an "
    "object that must be refused. Byte strings are lowercase hex without 0x.",
    {
        "seal": (
            {"fileKey": HEX32, "noncePrefix": v.hexn(8), "chunkSize": {"type": "integer", "minimum": 1, "maximum": MAX_CHUNK}, "plaintext": v.HEX},
            [{"header": v.hexn(HEADER_LEN), "ciphertext": v.HEX, "ciphertextSha256": HEX32, "plaintextSha256": HEX32}],
        ),
        "open": ({"fileKey": HEX32, "ciphertext": v.HEX}, [v.REJECT]),
    },
)

if __name__ == "__main__":
    v.main(
        suite=SUITE,
        version=VERSION,
        script="tools/vectors/generate_stream.py",
        libraries=["cryptography"],
        build=build,
        schema=SCHEMA,
        doc=__doc__,
    )
