#!/usr/bin/env python3
"""Independent generator for the `invite-link` suite: decoding an invite link (M1-1h; G-12, D-69).

04 §3.6 (D-69, raw DEFLATE): the payload is base64url(deflateRaw(utf8(JSON))), raw DEFLATE (RFC
1951) with no zlib header or Adler-32 (RFC 1950) and no gzip wrapper (RFC 1952), base64url without
padding. It is shared as `https://<invite-host>/i#<payload>` and accepted from the full URL or the
bare payload. The decoder, each step failing closed (the D-69 bounds are proposed, derived):
  1. the whole input is length-checked first (21 846 characters plus the prefix), then it must be
     exactly the canonical prefix `https://agentlink.4thtech.io/i#` (06 §7.1) followed by the
     payload, or the bare payload: no other scheme, host, port or path, nothing before the prefix,
     no second `#`, no percent-encoding; the payload is at most 21 846 characters of strict
     base64url, checked on the text before decoding;
  2. inflate, stopping as soon as the output exceeds 16 384 bytes (before any parse);
  3. refuse a malformed stream, a truncated stream (no final block) and bytes after the final block;
  4. UTF-8 with fatal errors and the byte-order mark kept (so a BOM is refused), I-JSON (duplicate
     keys refused; integer tokens per 04 §2.4.1; RFC 8259 whitespace allowed) and the strict invite
     schema (the `pairing-bodies` reference parser, including the 256-code-point `name`).
Version 2 (IR-M1-2d-1 F03): the step 1 prefix rule as merged in 04 §3.6 (PR #70), with one
rejection per rule, a leading BOM, and a name at and over 256 code points.
The compressed bytes are not canonical (D-69), so there are no encoder-output cases: `decodeInviteLink`
gives a fixed link and the JCS text (RFC 8785) of the decoded invite, or a rejection.

The DEFLATE streams are written by this generator's own small encoder (stored blocks, fixed Huffman
and dynamic Huffman blocks, greedy LZ77), so the bytes do not depend on the zlib build. Every stream
is cross-checked with CPython's `zlib` inflater (wbits = -15): accepted streams must inflate to the
JSON with nothing left over, and the rejected ones must fail there for the stated reason. The invite
is the `pairing-bodies` invite (synthetic keys and secret).

Usage: python3 -I tools/vectors/generate_invite_link.py --check [FILE] | --write
"""

import heapq
import json
import re
import struct
import sys
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import generate_pairing_bodies as bodies  # noqa: E402
import vectorlib as v  # noqa: E402

SUITE = "invite-link"
VERSION = 2
SPEC = "04 §3.6 invite encoding (D-69)"
URL_PREFIX = "https://agentlink.4thtech.io/i#"  # the canonical link (06 §7.1)
MAX_PAYLOAD_CHARS = 21846
MAX_INFLATED = 16384

# --- a small, deterministic raw DEFLATE encoder (RFC 1951) ----------------------------------------

LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
LENGTH_EXTRA = [0] * 8 + [1] * 4 + [2] * 4 + [3] * 4 + [4] * 4 + [5] * 4 + [0]
DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]
DIST_EXTRA = [0, 0, 0, 0] + [i // 2 for i in range(2, 28)]
CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]


class Bits:
    def __init__(self):
        self.out = bytearray()
        self.acc = 0
        self.n = 0

    def put(self, value, count):
        """`count` bits of `value`, least significant first (RFC 1951 §3.1.1)."""
        self.acc |= value << self.n
        self.n += count
        while self.n >= 8:
            self.out.append(self.acc & 0xFF)
            self.acc >>= 8
            self.n -= 8

    def code(self, code, length):
        """A Huffman code, most significant bit first."""
        self.put(int(format(code, f"0{length}b")[::-1], 2), length)

    def align(self):
        if self.n:
            self.put(0, 8 - self.n)

    def bytes(self):
        out = bytearray(self.out)
        if self.n:
            out.append(self.acc & 0xFF)
        return bytes(out)


def canonical_codes(lengths):
    """RFC 1951 §3.2.2."""
    bl_count = [0] * 16
    for length in lengths:
        if length:
            bl_count[length] += 1
    code, next_code = 0, [0] * 16
    for bits in range(1, 16):
        code = (code + bl_count[bits - 1]) << 1
        next_code[bits] = code
    codes = [0] * len(lengths)
    for symbol, length in enumerate(lengths):
        if length:
            codes[symbol] = next_code[length]
            next_code[length] += 1
    return codes


FIXED_LIT = [8] * 144 + [9] * 112 + [7] * 24 + [8] * 8
FIXED_DIST = [5] * 30


def lz77(data):
    """Greedy LZ77: a list of literal bytes and (length, distance) pairs."""
    tokens, heads, i = [], {}, 0
    while i < len(data):
        best_len, best_dist = 0, 0
        key = data[i : i + 3]
        for j in reversed(heads.get(key, [])[-64:]):
            if i - j > 32768:
                break
            n = 0
            while n < 258 and i + n < len(data) and data[j + n] == data[i + n]:
                n += 1
            if n > best_len:
                best_len, best_dist = n, i - j
            if best_len == 258:
                break
        if best_len >= 3:
            for k in range(i, i + best_len):
                heads.setdefault(data[k : k + 3], []).append(k)
            tokens.append((best_len, best_dist))
            i += best_len
        else:
            heads.setdefault(key, []).append(i)
            tokens.append(data[i])
            i += 1
    return tokens


def symbol_of(table_base, table_extra, value):
    for index in range(len(table_base) - 1, -1, -1):
        if value >= table_base[index]:
            return index, value - table_base[index], table_extra[index]
    raise AssertionError(value)


def write_tokens(bits, tokens, lit_lengths, dist_lengths):
    lit_codes, dist_codes = canonical_codes(lit_lengths), canonical_codes(dist_lengths)
    for token in tokens:
        if isinstance(token, int):
            bits.code(lit_codes[token], lit_lengths[token])
            continue
        length, distance = token
        index, extra, nbits = (28, 0, 0) if length == 258 else symbol_of(LENGTH_BASE, LENGTH_EXTRA, length)
        bits.code(lit_codes[257 + index], lit_lengths[257 + index])
        bits.put(extra, nbits)
        index, extra, nbits = symbol_of(DIST_BASE, DIST_EXTRA, distance)
        bits.code(dist_codes[index], dist_lengths[index])
        bits.put(extra, nbits)
    bits.code(lit_codes[256], lit_lengths[256])


def huffman_lengths(freqs, limit):
    """Huffman code lengths for the used symbols; fails rather than length-limit."""
    used = [s for s, f in enumerate(freqs) if f]
    lengths = [0] * len(freqs)
    if len(used) == 1:
        lengths[used[0]] = 1
        return lengths
    heap = [(freqs[s], s, (s,)) for s in used]
    heapq.heapify(heap)
    while len(heap) > 1:
        f1, t1, s1 = heapq.heappop(heap)
        f2, t2, s2 = heapq.heappop(heap)
        for s in s1 + s2:
            lengths[s] += 1
        heapq.heappush(heap, (f1 + f2, min(t1, t2), s1 + s2))
    if max(lengths) > limit:
        v.fail("Huffman code too long for this small encoder")
    return lengths


def block_stored(bits, chunk, final):
    bits.put(1 if final else 0, 1)
    bits.put(0, 2)
    bits.align()
    bits.put(len(chunk), 16)
    bits.put(len(chunk) ^ 0xFFFF, 16)
    for byte in chunk:
        bits.put(byte, 8)


def block_fixed(bits, chunk, final):
    bits.put(1 if final else 0, 1)
    bits.put(1, 2)
    write_tokens(bits, lz77(chunk), FIXED_LIT, FIXED_DIST)


def block_dynamic(bits, chunk, final):
    tokens = lz77(chunk)
    lit_freq, dist_freq = [0] * 286, [0] * 30
    lit_freq[256] = 1
    for token in tokens:
        if isinstance(token, int):
            lit_freq[token] += 1
        else:
            length, distance = token
            lit_freq[257 + (28 if length == 258 else symbol_of(LENGTH_BASE, LENGTH_EXTRA, length)[0])] += 1
            dist_freq[symbol_of(DIST_BASE, DIST_EXTRA, distance)[0]] += 1
    # Two distance symbols at least, so the distance code is complete.
    for s in (0, 1):
        if sum(1 for f in dist_freq if f) < 2 and not dist_freq[s]:
            dist_freq[s] = 1
    lit_lengths, dist_lengths = huffman_lengths(lit_freq, 15), huffman_lengths(dist_freq, 15)
    hlit = max(s for s, n in enumerate(lit_lengths) if n) + 1
    hdist = max(s for s, n in enumerate(dist_lengths) if n) + 1
    sequence = lit_lengths[:hlit] + dist_lengths[:hdist]  # code lengths 0-15, no run-length codes
    cl_freq = [0] * 19
    for n in sequence:
        cl_freq[n] += 1
    if sum(1 for f in cl_freq if f) < 2:
        v.fail("degenerate code-length alphabet")
    cl_lengths = huffman_lengths(cl_freq, 7)
    hclen = max(i for i, s in enumerate(CL_ORDER) if cl_lengths[s]) + 1
    hclen = max(hclen, 4)
    bits.put(1 if final else 0, 1)
    bits.put(2, 2)
    bits.put(hlit - 257, 5)
    bits.put(hdist - 1, 5)
    bits.put(hclen - 4, 4)
    for s in CL_ORDER[:hclen]:
        bits.put(cl_lengths[s], 3)
    cl_codes = canonical_codes(cl_lengths)
    for n in sequence:
        bits.code(cl_codes[n], cl_lengths[n])
    write_tokens(bits, tokens, lit_lengths + [0] * (288 - len(lit_lengths)), dist_lengths)


def deflate(blocks):
    """`blocks`: (kind, chunk) pairs, kind in stored / fixed / dynamic; the last one is final."""
    bits = Bits()
    for index, (kind, chunk) in enumerate(blocks):
        {"stored": block_stored, "fixed": block_fixed, "dynamic": block_dynamic}[kind](bits, chunk, index == len(blocks) - 1)
    return bits.bytes()


# --- the reference decoder ------------------------------------------------------------------------


def zlib_inflate(stream):
    """CPython zlib, raw DEFLATE, with the cap applied while streaming. Returns the output or
    raises ValueError with the reason."""
    d = zlib.decompressobj(-15)
    try:
        out = d.decompress(stream, MAX_INFLATED + 1)
    except zlib.error as error:
        raise ValueError(f"malformed: {error}") from None
    if len(out) > MAX_INFLATED:
        raise ValueError("over the inflate cap")
    if d.unconsumed_tail:
        raise ValueError("over the inflate cap")
    if not d.eof:
        raise ValueError("truncated: no final block")
    if d.unused_data:
        raise ValueError("bytes after the final block")
    return out


def parse_ijson(data):
    def pairs(items):
        names = [k for k, _ in items]
        if len(set(names)) != len(names):
            raise ValueError("duplicate key")
        return dict(items)

    def integer(token):
        if not re.fullmatch(r"0|[1-9][0-9]*", token):
            raise ValueError("non-canonical integer token")
        return int(token)

    def no_number(token):
        raise ValueError("non-integer number token")

    try:
        text = data.decode("utf-8", errors="strict")
    except UnicodeDecodeError:
        raise ValueError("not UTF-8") from None
    try:
        return json.loads(text, object_pairs_hook=pairs, parse_int=integer, parse_float=no_number, parse_constant=no_number)
    except json.JSONDecodeError:
        raise ValueError("not JSON") from None


def decode_link(link):
    """04 §3.6 decoder step 1 (D-69, as merged): the whole input is length-checked first, then it
    must be exactly the canonical prefix followed by the payload, or the bare payload; no other URL
    form, no percent-encoding, nothing before the prefix, no second `#`."""
    if len(link) > MAX_PAYLOAD_CHARS + len(URL_PREFIX):
        raise ValueError("payload too long")
    if link.startswith(URL_PREFIX):
        payload = link[len(URL_PREFIX) :]
    elif re.fullmatch(r"[A-Za-z0-9_-]*", link):
        payload = link
    else:
        raise ValueError("not the canonical link or a bare payload")
    if len(payload) > MAX_PAYLOAD_CHARS:
        raise ValueError("payload too long")
    if payload == "":
        raise ValueError("empty payload")
    if not re.fullmatch(r"[A-Za-z0-9_-]+", payload):
        raise ValueError("not strict base64url")
    stream = v.unb64u(payload)
    invite = parse_ijson(zlib_inflate(stream))
    return bodies.parse_invite(invite)


# --- cases ----------------------------------------------------------------------------------------


def compact(value):
    """Compact JSON, non-ASCII unescaped (the encoder's form, D-69)."""
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def build():
    a = bodies.party("pairing-bodies-a", "Tali's Claude", bodies.RELAYS_A)
    invite = bodies.invite_of(a, v.det("pairing-bodies/invite-id", 16), v.det("pairing-bodies/secret", 32), v.det("pairing-bodies/nonce-a", 32))
    bodies.parse_invite(invite)
    jcs_text = v.jcs(invite).decode("utf-8")
    data = compact(invite)
    cases = []

    def case(case_id, why, stream_or_link, accept, reason=None, expect_invite=None):
        link = stream_or_link if isinstance(stream_or_link, str) else v.b64u(stream_or_link)
        try:
            result = v.jcs(decode_link(link)).decode("utf-8")
            outcome = None
        except ValueError as error:
            result, outcome = None, str(error)
        if accept and result != (expect_invite or jcs_text):
            v.fail(f"{case_id}: does not decode to the invite ({outcome})")
        if not accept and (result is not None or (reason and not outcome.startswith(reason))):
            v.fail(f"{case_id}: expected a rejection for {reason!r}, got {outcome!r}")
        cases.append(
            v.case(
                case_id,
                f"{SPEC}: {why}" + ("" if accept else "; refused, no partial result"),
                {"op": "decodeInviteLink", "link": link},
                {"inviteJcs": result} if accept else {"outcome": "reject"},
            )
        )

    half = len(data) // 2
    fixed = deflate([("fixed", data)])
    dynamic = deflate([("dynamic", data)])
    case("decode-bare-fixed", "the bare payload, one fixed-Huffman block", fixed, True)
    case("decode-url-fixed", "the full canonical URL (06 §7.1)", URL_PREFIX + v.b64u(fixed), True)
    case("decode-bare-dynamic", "one dynamic-Huffman block (what platform encoders write)", dynamic, True)
    case("decode-url-dynamic", "the full URL, one dynamic-Huffman block", URL_PREFIX + v.b64u(dynamic), True)
    case("decode-stored", "one stored (uncompressed) block", deflate([("stored", data)]), True)
    case("decode-mixed-blocks", "a stored, a fixed and a dynamic block in one stream", deflate([("stored", data[:100]), ("fixed", data[100:half]), ("dynamic", data[half:])]), True)
    case("decode-empty-blocks", "an empty stored block before the data", deflate([("stored", b""), ("dynamic", data)]), True)
    reordered = {k: invite[k] for k in reversed(list(invite))}
    case("decode-other-key-order-whitespace", "JSON with other key order and whitespace (only the decoded invite counts)", deflate([("dynamic", json.dumps(reordered, indent=2).encode())]), True)
    unicode_party = bodies.party("pairing-bodies-a", "Tali’s Claude ✓", bodies.RELAYS_A)
    unicode_invite = bodies.invite_of(unicode_party, v.det("pairing-bodies/invite-id", 16), v.det("pairing-bodies/secret", 32), v.det("pairing-bodies/nonce-a", 32))
    case("decode-unicode-name", "a non-ASCII name written unescaped as UTF-8", deflate([("dynamic", compact(unicode_invite))]), True, expect_invite=v.jcs(unicode_invite).decode("utf-8"))

    # Size bounds: the inflated JSON at and over 16 384 bytes (whitespace makes it larger).
    def padded(size):
        text = compact(invite)
        out = text[:-1] + b" " * (size - len(text)) + b"}"
        if len(out) != size:
            v.fail("padding")
        return out

    case("decode-inflated-at-cap", f"the inflated JSON is exactly {MAX_INFLATED} bytes", deflate([("dynamic", padded(MAX_INFLATED))]), True)
    case("reject-inflated-over-cap", f"the inflated JSON is {MAX_INFLATED + 1} bytes (a valid invite with whitespace)", deflate([("dynamic", padded(MAX_INFLATED + 1))]), False, "over the inflate cap")
    bomb = deflate([("fixed", b"\x00" * (1 << 20))])
    if len(v.b64u(bomb)) > MAX_PAYLOAD_CHARS:
        v.fail("the deflate bomb is too long")
    case("reject-deflate-bomb", f"{len(bomb)} bytes that inflate to 1 MiB of zeros; refused at the cap, never buffered", bomb, False, "over the inflate cap")

    # Payload length: a valid invite in many small stored blocks, at and over 21 846 characters.
    def at_size(total):
        """The invite JSON (with 0-4 spaces of whitespace) in 1-byte stored blocks after empty ones,
        exactly `total` bytes. Each stored block costs 5 bytes plus its data."""
        for spaces in range(5):
            text = data[:-1] + b" " * spaces + b"}"
            size = 6 * len(text)
            if size <= total and (total - size) % 5 == 0:
                blocks = [("stored", b"")] * ((total - size) // 5) + [("stored", text[i : i + 1]) for i in range(len(text))]
                stream = deflate(blocks)
                if len(stream) == total:
                    return stream
        v.fail(f"no stored-block stream of {total} bytes")

    at_cap = at_size(16384)
    over = at_size(16385)
    if len(v.b64u(at_cap)) != MAX_PAYLOAD_CHARS or len(v.b64u(over)) != MAX_PAYLOAD_CHARS + 1:
        v.fail("payload length bounds")
    case("decode-payload-at-limit", f"a payload of exactly {MAX_PAYLOAD_CHARS} characters (a valid invite in many stored blocks)", at_cap, True)
    case("reject-payload-over-limit", f"a payload of {MAX_PAYLOAD_CHARS + 1} characters, refused on the text before decoding (it would inflate to a valid invite)", over, False, "payload too long")
    case("reject-url-payload-over-limit", f"the full URL with a payload of {MAX_PAYLOAD_CHARS + 1} characters", URL_PREFIX + v.b64u(over), False, "payload too long")

    # Wrappers and stream errors.
    zlib_wrapped = b"\x78\x9c" + dynamic + struct.pack(">I", zlib.adler32(data))
    case("reject-zlib-wrapped", "a zlib stream (RFC 1950 header and Adler-32) instead of raw DEFLATE", zlib_wrapped, False, "malformed")
    gzip_wrapped = b"\x1f\x8b\x08\x00\x00\x00\x00\x00\x00\xff" + dynamic + struct.pack("<II", zlib.crc32(data), len(data))
    case("reject-gzip-wrapped", "a gzip member (RFC 1952) instead of raw DEFLATE", gzip_wrapped, False, "malformed")
    case("reject-trailing-byte", "one zero byte after the final block", dynamic + b"\x00", False, "bytes after the final block")
    case("reject-trailing-adler32", "the Adler-32 of a zlib stream after the final block", dynamic + struct.pack(">I", zlib.adler32(data)), False, "bytes after the final block")
    case("reject-second-stream", "a second complete raw DEFLATE stream after the first", fixed + fixed, False, "bytes after the final block")
    case("reject-truncated", "the stream without its last 8 bytes", dynamic[:-8], False, "truncated")
    case("reject-no-final-block", "only non-final blocks (BFINAL never set)", non_final(data), False, "truncated")
    case("reject-reserved-block-type", "a block of the reserved type 11", bytes([0b111]) + dynamic[1:], False, "malformed")
    bad_nlen = bytearray(deflate([("stored", data)]))
    bad_nlen[3] ^= 0x01
    case("reject-stored-nlen", "a stored block whose NLEN is not the complement of LEN", bytes(bad_nlen), False, "malformed")

    # Text form of the payload (strict base64url, 04 §3.1; 06 §7.1).
    payload = v.b64u(dynamic)
    pad = "=" * (-len(payload) % 4) or "=="
    case("reject-padded", "the payload with base64 padding", payload + pad, False)
    if "-" not in payload and "_" not in payload:
        v.fail("pick a payload with - or _")
    case("reject-standard-alphabet", "the payload in the standard base64 alphabet (+ and /)", payload.replace("-", "+").replace("_", "/"), False)
    alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    if len(payload) % 4 in (2, 3):
        case("reject-trailing-bits", "the payload with non-zero trailing bits", payload[:-1] + alphabet[alphabet.index(payload[-1]) | 1], False)
    case("reject-whitespace", "the payload with a line break inside", payload[:40] + "\n" + payload[40:], False)
    case("reject-empty", "an empty payload", "", False)
    case("reject-url-empty", "the full URL with nothing after #", URL_PREFIX, False)

    # Step 1: exactly the canonical prefix, or the bare payload (D-69 as merged; 06 §7.1).
    other_forms = "not the canonical link or a bare payload"
    for case_id, link, why, reason in [
        ("reject-url-http", "http://agentlink.4thtech.io/i#" + payload, "the http scheme", other_forms),
        ("reject-url-other-host", "https://agentlink.example.com/i#" + payload, "another host", other_forms),
        ("reject-url-host-uppercase", "https://AgentLink.4thtech.io/i#" + payload, "the host in another case", other_forms),
        ("reject-url-host-port", "https://agentlink.4thtech.io:443/i#" + payload, "the host with an explicit port", other_forms),
        ("reject-url-other-path", "https://agentlink.4thtech.io/invite#" + payload, "another path", other_forms),
        ("reject-url-trailing-slash-path", "https://agentlink.4thtech.io/i/#" + payload, "the path /i/", other_forms),
        ("reject-url-query", "https://agentlink.4thtech.io/i?ref=x#" + payload, "a query before the fragment", other_forms),
        ("reject-url-leading-space", " " + URL_PREFIX + payload, "a space before the prefix", other_forms),
        ("reject-url-leading-character", "x" + URL_PREFIX + payload, "a character before the prefix", other_forms),
        ("reject-bare-leading-space", " " + payload, "a bare payload with a leading space", other_forms),
        ("reject-url-second-hash", URL_PREFIX + payload + "#" + payload, "a second #", "not strict base64url"),
        ("reject-url-percent-hash", "https://agentlink.4thtech.io/i%23" + payload, "the # percent-encoded", other_forms),
        ("reject-url-percent-payload", URL_PREFIX + payload.replace("-", "%2D", 1).replace("_", "%5F", 1), "percent-encoding inside the payload", "not strict base64url"),
        ("reject-bare-percent-payload", payload.replace("-", "%2D", 1).replace("_", "%5F", 1), "percent-encoding inside a bare payload", other_forms),
    ]:
        case(case_id, why, link, False, reason)

    # Step 4: a leading byte-order mark reaches the parser and is refused (ignoreBOM: true).
    case("reject-bom", "the inflated JSON starts with a UTF-8 byte-order mark", deflate([("dynamic", b"\xef\xbb\xbf" + data)]), False, "not JSON")

    # `name` (04 §3.4): at most 256 code points.
    name_256 = "Agent \U0001d400\U0001d401 \u00e9 " + "x" * 245
    if len(name_256) != 256:
        v.fail("name_256")
    named = [bodies.invite_of(bodies.party("pairing-bodies-a", name, bodies.RELAYS_A), v.det("pairing-bodies/invite-id", 16), v.det("pairing-bodies/secret", 32), v.det("pairing-bodies/nonce-a", 32)) for name in (name_256, name_256 + "x")]
    case("decode-name-256-code-points", "a name of exactly 256 code points (04 §3.4)", deflate([("dynamic", compact(named[0]))]), True, expect_invite=v.jcs(named[0]).decode("utf-8"))
    case("reject-name-257-code-points", "a name of 257 code points (04 §3.4: at most 256)", deflate([("dynamic", compact(named[1]))]), False, "name")

    # Inflated content that is not a valid invite.
    case("reject-not-utf8", "the inflated bytes are not UTF-8 (fatal decoding, no replacement)", deflate([("dynamic", data.replace(b"Tali", b"T\xffli"))]), False, "not UTF-8")
    dup = data[:-1] + b',"v":1}'
    case("reject-duplicate-key", "the JSON repeats a key (I-JSON)", deflate([("dynamic", dup)]), False, "duplicate key")
    case("reject-float-token", "expiresAt written as 1760604800.0", deflate([("dynamic", data.replace(b'"expiresAt":1760604800', b'"expiresAt":1760604800.0'))]), False, "non-integer")
    case("reject-not-json", "the inflated bytes are not JSON", deflate([("dynamic", data[:-1])]), False, "not JSON")
    case("reject-json-array", "the JSON is an array holding the invite", deflate([("dynamic", b"[" + data + b"]")]), False, "not exactly")
    one_relay = bodies.invite_of(bodies.party("pairing-bodies-a", "Tali's Claude", bodies.RELAYS_A[:1]), v.det("pairing-bodies/invite-id", 16), v.det("pairing-bodies/secret", 32), v.det("pairing-bodies/nonce-a", 32))
    case("reject-invite-one-relay", "a well-formed invite with one relay (strict schema, 04 §3.4)", deflate([("dynamic", compact(one_relay))]), False, "relays")
    case("reject-invite-unknown-key", "an invite with an extra key (strict schema)", deflate([("dynamic", data[:-1] + b',"nonceA":"x"}')]), False, "not exactly")
    return cases


def non_final(data):
    """A stored block with BFINAL = 0 and nothing after it."""
    bits = Bits()
    block_stored(bits, data, False)
    return bits.bytes()


SCHEMA = v.case_schema(
    SUITE,
    "04 §3.6 invite encoding (G-12, D-69): `decodeInviteLink` decodes a full invite URL or a bare "
    "payload (base64url of raw DEFLATE of the invite JSON) and gives the JCS text of the invite, or "
    "a rejection: over 21 846 characters, not strict base64url, a malformed, truncated, wrapped or "
    "trailing-byte stream, over 16 384 inflated bytes, not UTF-8, not I-JSON, or not a valid invite.",
    {"decodeInviteLink": ({"link": v.STRING}, [{"inviteJcs": v.STRING}, v.REJECT])},
)

if __name__ == "__main__":
    v.main(
        suite=SUITE,
        version=VERSION,
        script="tools/vectors/generate_invite_link.py",
        libraries=["cryptography", "coincurve", "pycryptodome", "rfc8785"],
        build=build,
        schema=SCHEMA,
        doc=__doc__,
    )
