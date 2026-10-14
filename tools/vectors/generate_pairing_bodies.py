#!/usr/bin/env python3
"""Independent generator for the `pairing-bodies` suite: the strict pairing-body schemas (M1-1h; M1-2d).

The bodies, exactly as 04 lists them (G-23, G-24, G-28; D-58 amended by D-65):
  invite         {v, inviteId, secret, card, cardSig, cardAgentSig, codeCommit, name, relays, expiresAt}  (04 §3.6)
  handshake      {inviteId, card, cardSig, cardAgentSig, name, relays, proof, codeNonce, codeCommit,
                  inviterCardHash}                                                                     (04 §3.6)
  handshake-ack  {inviteId, handshakeId, handshakeHash, codeReveal, card, cardSig, relays}             (04 §3.4.1)
  card-update    {card, cardSig, name, relays}                                                         (04 §3.4.1)
Every field is required and no other key is allowed. Encodings per 04 §2.4.1: `inviteId` and
`handshakeId` base64url of exactly 16 bytes; `secret`, `codeCommit`, `codeNonce`, `codeReveal` and
`proof` base64url of exactly 32 bytes; `handshakeHash` 0x + 64 lowercase hex (an envelopeHash);
`inviterCardHash` 64 lowercase hex, no prefix; `cardSig` and `cardAgentSig` 0x + 130 lowercase hex in
the canonical ECDSA form (r, s in [1, n - 1], s <= n/2, v in {27, 28}); `card` in the card JSON form
(04 §2.4); `v` = 1; integers are JSON integers in [0, 2^53 - 1]. `relays` (04 §3.4, G-24): 2 to 16
entries, unique, each passing the raw-string relay URL rule of 04 §4. Non-canonical forms are
rejected, never normalised.

This suite is the schema only: signatures, `nameHash`/`relaysHash`, the proof and the commitment
are checked by the core (M1-7c) and by `safety-code-recompute`. The accepted bodies are still fully
consistent (real card signatures, matching hashes, a real proof and commitment), so they can be
reused. The reference parser is this generator's own reading of 04 (Python `re`); cards and their
signatures come from the `eip712` generator, the proof from the `pairing` generator. Keys, nonces
and the invite secret are synthetic, derived from labelled test seeds.

Usage: python3 -I tools/vectors/generate_pairing_bodies.py --check [FILE] | --write
"""

import copy
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import generate_eip712 as eip712  # noqa: E402
import generate_pairing as pairing  # noqa: E402
import vectorlib as v  # noqa: E402

SUITE = "pairing-bodies"
VERSION = 1
COMMIT_TAG = "agentlink/safety-commit/v1"
N = v.SECP256K1_N
MAX_INT = 2**53 - 1
RELAYS_MIN, RELAYS_MAX = 2, 16

INVITE_FIELDS = ("v", "inviteId", "secret", "card", "cardSig", "cardAgentSig", "codeCommit", "name", "relays", "expiresAt")
HANDSHAKE_FIELDS = ("inviteId", "card", "cardSig", "cardAgentSig", "name", "relays", "proof", "codeNonce", "codeCommit", "inviterCardHash")
ACK_FIELDS = ("inviteId", "handshakeId", "handshakeHash", "codeReveal", "card", "cardSig", "relays")
CARD_UPDATE_FIELDS = ("card", "cardSig", "name", "relays")


# --- the reference parser (04 §2.4.1, §3.4, §3.4.1, §3.6, §4) ------------------------------------

DENIED_SUFFIXES = (".localhost", ".localdomain", ".local", ".internal", ".home.arpa")


def parse_relay_url(url):
    """04 §4, relay URLs: checked on the raw string, before any URL parser."""
    if not isinstance(url, str) or len(url) > 256:
        raise ValueError("relay URL: not a string of at most 256 characters")
    if not re.fullmatch(r"[\x21-\x7e]+", url) or "%" in url or "\\" in url:
        raise ValueError("relay URL: not printable ASCII without %, \\ or whitespace")
    m = re.fullmatch(r"wss://([^:/]+)(?::([^/]*))?(/.*)?", url)
    if not m:
        raise ValueError("relay URL: not wss:// + host [+ :port] [+ path]")
    host, port, path = m.groups()
    if len(host) > 253:
        raise ValueError("relay URL: host too long")
    labels = host.split(".")
    if len(labels) < 2:
        raise ValueError("relay URL: fewer than two labels")
    for label in labels:
        if not re.fullmatch(r"[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?", label):
            raise ValueError("relay URL: bad label")
        if re.fullmatch(r"[0-9]+|0x[0-9a-f]+", label):
            raise ValueError("relay URL: numeric label")
    if not re.fullmatch(r"[a-z]{2,63}|xn--[a-z0-9-]{1,59}", labels[-1]):
        raise ValueError("relay URL: bad last label")
    if host == "localhost" or host.endswith(DENIED_SUFFIXES):
        raise ValueError("relay URL: denied name")
    if port is not None and (not re.fullmatch(r"[1-9][0-9]{0,4}", port) or int(port) > 65535):
        raise ValueError("relay URL: bad port")
    if path is not None and not re.fullmatch(r"/[A-Za-z0-9._~!$&'()*+,;=:@/-]*", path):
        raise ValueError("relay URL: bad path")
    return url


def parse_relay_list(relays):
    """04 §3.4: a list carried with a card has 2 to 16 entries, unique, each a valid relay URL."""
    if not isinstance(relays, list) or not RELAYS_MIN <= len(relays) <= RELAYS_MAX:
        raise ValueError("relays: not a list of 2 to 16 entries")
    for url in relays:
        parse_relay_url(url)
    if len(set(relays)) != len(relays):
        raise ValueError("relays: duplicate entry")
    return relays


def b64u_exact(value, n):
    if not isinstance(value, str):
        raise ValueError("not a string")
    raw = v.unb64u(value)
    if len(raw) != n:
        raise ValueError("wrong length")
    return raw


def parse_ecdsa(value):
    if not isinstance(value, str) or not re.fullmatch(r"0x[0-9a-f]{130}", value):
        raise ValueError("signature: not 0x + 130 lowercase hex")
    raw = bytes.fromhex(value[2:])
    r, s = int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:64], "big")
    if not 1 <= r < N or not 1 <= s <= N // 2 or raw[64] not in (27, 28):
        raise ValueError("signature: not canonical ECDSA")
    return value


def parse_integer(value):
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= MAX_INT:
        raise ValueError("not a JSON integer in [0, 2^53 - 1]")
    return value


def exact_keys(body, fields):
    if not isinstance(body, dict) or set(body) != set(fields):
        raise ValueError("not exactly the body's fields")


def parse_name(value):
    if not isinstance(value, str):
        raise ValueError("name: not a string")


def parse_invite(body):
    exact_keys(body, INVITE_FIELDS)
    if parse_integer(body["v"]) != 1:
        raise ValueError("v is not 1")
    b64u_exact(body["inviteId"], 16)
    b64u_exact(body["secret"], 32)
    b64u_exact(body["codeCommit"], 32)
    eip712.parse_card(body["card"])
    parse_ecdsa(body["cardSig"])
    parse_ecdsa(body["cardAgentSig"])
    parse_name(body["name"])
    parse_relay_list(body["relays"])
    parse_integer(body["expiresAt"])
    return body


def parse_handshake(body):
    exact_keys(body, HANDSHAKE_FIELDS)
    b64u_exact(body["inviteId"], 16)
    eip712.parse_card(body["card"])
    parse_ecdsa(body["cardSig"])
    parse_ecdsa(body["cardAgentSig"])
    parse_name(body["name"])
    parse_relay_list(body["relays"])
    for field in ("proof", "codeNonce", "codeCommit"):
        b64u_exact(body[field], 32)
    if not isinstance(body["inviterCardHash"], str) or not re.fullmatch(r"[0-9a-f]{64}", body["inviterCardHash"]):
        raise ValueError("inviterCardHash: not 64 lowercase hex")
    return body


def parse_handshake_ack(body):
    exact_keys(body, ACK_FIELDS)
    b64u_exact(body["inviteId"], 16)
    b64u_exact(body["handshakeId"], 16)
    if not isinstance(body["handshakeHash"], str) or not re.fullmatch(r"0x[0-9a-f]{64}", body["handshakeHash"]):
        raise ValueError("handshakeHash: not 0x + 64 lowercase hex")
    b64u_exact(body["codeReveal"], 32)
    eip712.parse_card(body["card"])
    parse_ecdsa(body["cardSig"])
    parse_relay_list(body["relays"])
    return body


def parse_card_update(body):
    exact_keys(body, CARD_UPDATE_FIELDS)
    eip712.parse_card(body["card"])
    parse_ecdsa(body["cardSig"])
    parse_name(body["name"])
    parse_relay_list(body["relays"])
    return body


PARSERS = {
    "parseInvite": parse_invite,
    "parseHandshake": parse_handshake,
    "parseHandshakeAck": parse_handshake_ack,
    "parseCardUpdate": parse_card_update,
    "parseRelayList": parse_relay_list,
}


# --- consistent test bodies ----------------------------------------------------------------------

RELAYS_A = ["wss://relay.example.com", "wss://nostr.example.org:7447/inbox"]
RELAYS_B = ["wss://relay.example.net", "wss://relay.example.com"]


def relay_set(n, label="r"):
    return [f"wss://{label}{i}.relays.example.com" for i in range(n)]


def party(label, name, relays, key_epoch=0):
    """A card and both signatures over it (owner cardSig, agent cardAgentSig), with nameHash and
    relaysHash over exactly `name` and `relays`."""
    card = eip712.make_card(label, name, relays, 1760000000, 1791536000, key_epoch)
    digest = eip712.card_digest(card)
    return {
        "card": card,
        "name": name,
        "relays": list(relays),
        "cardSig": eip712.card_sig(v.det(f"eip712/{label}/owner/evm", 32), digest),
        "cardAgentSig": eip712.card_sig(v.det(f"eip712/{label}/agent/evm", 32), digest),
    }


def commit(invite_id, nonce_a):
    return v.tagged_hash(COMMIT_TAG, invite_id + nonce_a)


def invite_of(a, invite_id, secret, nonce_a, expires_at=1760604800):
    return {
        "v": 1,
        "inviteId": v.b64u(invite_id),
        "secret": v.b64u(secret),
        "card": a["card"],
        "cardSig": a["cardSig"],
        "cardAgentSig": a["cardAgentSig"],
        "codeCommit": v.b64u(commit(invite_id, nonce_a)),
        "name": a["name"],
        "relays": a["relays"],
        "expiresAt": expires_at,
    }


def handshake_of(a, b, invite_id, secret, nonce_a, nonce_b):
    return {
        "inviteId": v.b64u(invite_id),
        "card": b["card"],
        "cardSig": b["cardSig"],
        "cardAgentSig": b["cardAgentSig"],
        "name": b["name"],
        "relays": b["relays"],
        "proof": v.b64u(pairing.proof_of(secret, invite_id, b["card"])),
        "codeNonce": v.b64u(nonce_b),
        "codeCommit": v.b64u(commit(invite_id, nonce_a)),
        "inviterCardHash": v.sha256(v.jcs(a["card"])).hex(),
    }


def ack_of(a, invite_id, handshake_id, handshake_hash, nonce_a):
    return {
        "inviteId": v.b64u(invite_id),
        "handshakeId": v.b64u(handshake_id),
        "handshakeHash": "0x" + handshake_hash.hex(),
        "codeReveal": v.b64u(nonce_a),
        "card": a["card"],
        "cardSig": a["cardSig"],
        "relays": a["relays"],
    }


def build():
    a = party("pairing-bodies-a", "Tali's Claude", RELAYS_A)
    b = party("pairing-bodies-b", "Denis's Codex", RELAYS_B)
    invite_id = v.det("pairing-bodies/invite-id", 16)
    secret = v.det("pairing-bodies/secret", 32)
    nonce_a = v.det("pairing-bodies/nonce-a", 32)
    nonce_b = v.det("pairing-bodies/nonce-b", 32)
    handshake_id = v.det("pairing-bodies/handshake-id", 16)
    # A synthetic envelopeHash: the schema checks only its spelling (the real one is in
    # safety-code-recompute).
    handshake_hash = v.sha256(b"pairing-bodies/handshake-envelope-hash")
    bodies = {
        "parseInvite": ("invite", "04 §3.6 invite", invite_of(a, invite_id, secret, nonce_a), INVITE_FIELDS),
        "parseHandshake": ("handshake", "04 §3.6 handshake", handshake_of(a, b, invite_id, secret, nonce_a, nonce_b), HANDSHAKE_FIELDS),
        "parseHandshakeAck": ("ack", "04 §3.4.1 handshake-ack", ack_of(a, invite_id, handshake_id, handshake_hash, nonce_a), ACK_FIELDS),
        "parseCardUpdate": ("card-update", "04 §3.4.1 card-update", {"card": a["card"], "cardSig": a["cardSig"], "name": a["name"], "relays": a["relays"]}, CARD_UPDATE_FIELDS),
    }
    cases = []

    def consistent(case_id, body):
        """An accepted body also passes the core's checks, so it can be reused (M1-7c)."""
        card = body["card"]
        ok = eip712.verify_card_sig(card, body["cardSig"])
        ok = ok and ("cardAgentSig" not in body or eip712.verify_card_sig(card, body["cardAgentSig"], "agentEvm"))
        ok = ok and card["relaysHash"] == eip712.card_hashes("", body["relays"])[1]
        ok = ok and ("name" not in body or card["nameHash"] == eip712.card_hashes(body["name"], [])[0])
        ok = ok and ("proof" not in body or pairing.verify(v.b64u(secret), body["inviteId"], card, body["proof"]))
        ok = ok and ("codeReveal" not in body or v.b64u(commit(invite_id, v.unb64u(body["codeReveal"]))) == bodies["parseInvite"][2]["codeCommit"])
        if not ok:
            v.fail(f"{case_id}: an accepted body is not consistent")

    def case(case_id, op, source, value, accept):
        field = "relays" if op == "parseRelayList" else "body"
        try:
            PARSERS[op](copy.deepcopy(value))
            ok = True
        except ValueError:
            ok = False
        if ok != accept:
            v.fail(f"{case_id}: unexpected parse result")
        if accept and op != "parseRelayList":
            consistent(case_id, value)
        cases.append(
            v.case(
                case_id,
                source + ("" if accept else "; rejected, never normalised"),
                {"op": op, field: value},
                {"outcome": "accept" if accept else "reject"},
            )
        )

    def with_relays(op, n, label):
        """The body with a consistent card (relaysHash over the list) carrying `n` relays."""
        prefix, _, base, _ = bodies[op]
        relays = relay_set(n, label)
        if op == "parseHandshake":
            other = party("pairing-bodies-b", b["name"], relays)
            body = handshake_of(a, other, invite_id, secret, nonce_a, nonce_b)
        else:
            other = party("pairing-bodies-a", a["name"], relays)
            if op == "parseInvite":
                body = invite_of(other, invite_id, secret, nonce_a)
            elif op == "parseHandshakeAck":
                body = ack_of(other, invite_id, handshake_id, handshake_hash, nonce_a)
            else:
                body = {"card": other["card"], "cardSig": other["cardSig"], "name": other["name"], "relays": other["relays"]}
        return body

    def changed(op, **changes):
        body = copy.deepcopy(bodies[op][2])
        body.update(changes)
        return body

    for op, (prefix, spec, body, fields) in bodies.items():
        case(f"{prefix}-accept", op, f"{spec}: every field present and canonical, 2 relays", body, True)
        case(f"{prefix}-accept-16-relays", op, f"{spec}: 16 relays, the maximum (04 §3.4)", with_relays(op, 16, "max"), True)
        for n in (0, 1, 17):
            case(f"{prefix}-reject-{n}-relays", op, f"{spec}: {n} relays (04 §3.4: 2 to 16; G-24, the minimum was 1)", with_relays(op, n, f"n{n}"), False)
        case(f"{prefix}-reject-duplicate-relay", op, f"{spec}: a relay listed twice (04 §3.4: unique)", changed(op, relays=[body["relays"][0], body["relays"][0]]), False)
        case(f"{prefix}-reject-bad-relay-url", op, f"{spec}: one relay URL fails the relay URL rule (04 §4); the whole body is rejected", changed(op, relays=[body["relays"][0], "wss://127.0.0.1"]), False)
        for field in fields:
            missing = copy.deepcopy(body)
            del missing[field]
            slug = re.sub(r"([a-z])([A-Z])", r"\1-\2", field).lower()
            case(f"{prefix}-reject-missing-{slug}", op, f"{spec}: without `{field}` (every field is required)", missing, False)
        case(f"{prefix}-reject-relays-not-array", op, f"{spec}: `relays` as a single string", changed(op, relays=body["relays"][0]), False)
        case(f"{prefix}-reject-card-unknown-key", op, f"{spec}: the card carries a thirteenth key (04 §2.4 card JSON form)", changed(op, card={**body["card"], "label": "x"}), False)
        case(f"{prefix}-reject-card-sig-uppercase", op, f"{spec}: `cardSig` in upper-case hex (04 §2.4.1)", changed(op, cardSig="0x" + body["cardSig"][2:].upper()), False)
        high_s = bytes.fromhex(body["cardSig"][2:])
        s = int.from_bytes(high_s[32:64], "big")
        malleated = "0x" + (high_s[:32] + (N - s).to_bytes(32, "big") + bytes([55 - high_s[64]])).hex()
        case(f"{prefix}-reject-card-sig-high-s", op, f"{spec}: `cardSig` in its malleated high-s form (04 §2.4.1)", changed(op, cardSig=malleated), False)

    # Extra keys (strict schemas, M1-2a): values that belong to other bodies or must never travel.
    for case_id, op, key, value, why in [
        ("invite-reject-extra-nonce-a", "parseInvite", "nonceA", v.b64u(nonce_a), "the committed nonceA (it travels only as the ack's codeReveal)"),
        ("invite-reject-extra-label", "parseInvite", "label", "Denis", "a `label` (stored locally by A, never in the invite)"),
        ("invite-reject-extra-proof-key", "parseInvite", "proofKey", v.b64u(pairing.proof_key(secret)), "A's stored proofKey"),
        ("handshake-reject-extra-code-reveal", "parseHandshake", "codeReveal", v.b64u(nonce_a), "a `codeReveal` (an ack field)"),
        ("handshake-reject-extra-handshake-hash", "parseHandshake", "handshakeHash", "0x" + handshake_hash.hex(), "a `handshakeHash` (an ack field)"),
        ("ack-reject-extra-name", "parseHandshakeAck", "name", a["name"], "a `name` (04 §3.4.1 lists no name in the ack)"),
        ("ack-reject-extra-card-agent-sig", "parseHandshakeAck", "cardAgentSig", a["cardAgentSig"], "a `cardAgentSig` (the ack carries cardSig only)"),
        ("ack-reject-extra-code-commit", "parseHandshakeAck", "codeCommit", v.b64u(commit(invite_id, nonce_a)), "a `codeCommit` (an invite and handshake field)"),
        ("card-update-reject-extra-card-agent-sig", "parseCardUpdate", "cardAgentSig", a["cardAgentSig"], "a `cardAgentSig`"),
    ]:
        case(case_id, op, f"{bodies[op][1]}: an extra key, {why}", changed(op, **{key: value}), False)

    # Wrong lengths and second spellings of the binary fields (04 §2.4.1, §3.6, §3.6.1, §3.4.1).
    def b64(label, n):
        return v.b64u(v.det(f"pairing-bodies/{label}", n))

    spellings = []
    for op, fields16, fields32 in [
        ("parseInvite", ["inviteId"], ["secret", "codeCommit"]),
        ("parseHandshake", ["inviteId"], ["proof", "codeNonce", "codeCommit"]),
        ("parseHandshakeAck", ["inviteId", "handshakeId"], ["codeReveal"]),
    ]:
        for field, n in [(f, 16) for f in fields16] + [(f, 32) for f in fields32]:
            spellings.append((op, field, b64(f"{field}-short", n - 1), f"of {n - 1} bytes (it is exactly {n})", "short"))
            spellings.append((op, field, b64(f"{field}-long", n + 1), f"of {n + 1} bytes (it is exactly {n})", "long"))
            spellings.append((op, field, bodies[op][2][field] + "=", "with padding", "padded"))
    ack = bodies["parseHandshakeAck"][2]
    hs = bodies["parseHandshake"][2]
    inv = bodies["parseInvite"][2]
    spellings += [
        ("parseHandshakeAck", "handshakeHash", ack["handshakeHash"][2:], "without 0x (an envelopeHash is 0x + 64 hex)", "no-prefix"),
        ("parseHandshakeAck", "handshakeHash", "0x" + ack["handshakeHash"][2:].upper(), "in upper-case hex", "uppercase"),
        ("parseHandshakeAck", "handshakeHash", ack["handshakeHash"][:-2], "of 31 bytes", "short"),
        ("parseHandshakeAck", "handshakeHash", v.b64u(handshake_hash), "as base64url", "base64url"),
        ("parseHandshake", "inviterCardHash", "0x" + hs["inviterCardHash"], "with 0x (bare hex under a Nostr key)", "0x"),
        ("parseHandshake", "inviterCardHash", hs["inviterCardHash"].upper(), "in upper-case hex", "uppercase"),
        ("parseHandshake", "inviterCardHash", hs["inviterCardHash"][:-2], "of 31 bytes", "short"),
        ("parseHandshake", "inviterCardHash", v.b64u(bytes.fromhex(hs["inviterCardHash"])), "as base64url", "base64url"),
        ("parseInvite", "cardAgentSig", inv["cardAgentSig"][2:], "without 0x", "no-prefix"),
        ("parseHandshake", "cardAgentSig", hs["cardAgentSig"][:-2], "of 64 bytes (no v)", "64-bytes"),
        ("parseInvite", "v", 2, "= 2 (only v = 1 exists)", "2"),
        ("parseInvite", "v", "1", "as a string", "string"),
        ("parseInvite", "expiresAt", str(inv["expiresAt"]), "as a string", "string"),
        ("parseInvite", "expiresAt", 2**53, "= 2^53 (above 2^53 - 1)", "2-53"),
        ("parseInvite", "expiresAt", -1, "negative", "negative"),
        ("parseInvite", "name", None, "as null", "null"),
        ("parseCardUpdate", "name", 7, "as a number", "number"),
    ]
    for op, field, value, why, tag in spellings:
        slug = re.sub(r"([a-z])([A-Z])", r"\1-\2", field).lower()
        prefix, spec = bodies[op][0], bodies[op][1]
        case(f"{prefix}-reject-{slug}-{tag}", op, f"{spec}: `{field}` {why}", changed(op, **{field: value}), False)

    # The relay list on its own (04 §3.4) and the relay URL rule (04 §4), on the raw string.
    rl = "04 §3.4 relays (2 to 16, unique) and the 04 §4 relay URL rule"
    for case_id, relays, accept, why in [
        ("accept-2", RELAYS_A, True, "two relays, one with a port and a path"),
        ("accept-16", relay_set(16), True, "16 relays"),
        ("accept-idn-tld", ["wss://relay.example.xn--p1ai", "wss://relay.example.com"], True, "an xn-- last label"),
        ("accept-hyphen-label", ["wss://my-relay.example.com", "wss://relay.example.com:443"], True, "a hyphen inside a label; port 443"),
        ("reject-0", [], False, "an empty list"),
        ("reject-1", RELAYS_A[:1], False, "one relay (the minimum is 2, G-24)"),
        ("reject-17", relay_set(17), False, "17 relays"),
        ("reject-duplicate", [RELAYS_A[0], RELAYS_A[0]], False, "the same URL twice"),
        ("reject-not-string", [RELAYS_A[0], 7], False, "an entry that is not a string"),
        ("reject-ws", [RELAYS_A[0], "ws://relay.example.org"], False, "ws:// (only wss://)"),
        ("reject-https", [RELAYS_A[0], "https://relay.example.org"], False, "https://"),
        ("reject-uppercase-host", [RELAYS_A[0], "wss://Relay.example.org"], False, "an upper-case host (never lower-cased)"),
        ("reject-uppercase-scheme", [RELAYS_A[0], "WSS://relay.example.org"], False, "an upper-case scheme"),
        ("reject-ipv4", [RELAYS_A[0], "wss://127.0.0.1"], False, "an IPv4 literal"),
        ("reject-ipv4-integer", [RELAYS_A[0], "wss://2130706433.example.com"], False, "an all-decimal label"),
        ("reject-hex-label", [RELAYS_A[0], "wss://0x7f.example.com"], False, "a 0x-hex label"),
        ("reject-numeric-first-label", [RELAYS_A[0], "wss://1.relay.example"], False, "an all-numeric first label"),
        ("reject-ipv6", [RELAYS_A[0], "wss://[::1]"], False, "a bracketed IPv6 literal"),
        ("reject-localhost", [RELAYS_A[0], "wss://localhost"], False, "localhost"),
        ("reject-under-localhost", [RELAYS_A[0], "wss://relay.localhost"], False, "a name under .localhost"),
        ("reject-local", [RELAYS_A[0], "wss://relay.local"], False, "a name under .local"),
        ("reject-internal", [RELAYS_A[0], "wss://metadata.google.internal"], False, "a metadata name under .internal"),
        ("reject-home-arpa", [RELAYS_A[0], "wss://relay.home.arpa"], False, "a name under .home.arpa"),
        ("reject-single-label", [RELAYS_A[0], "wss://relay"], False, "a single-label host"),
        ("reject-trailing-dot", [RELAYS_A[0], "wss://relay.example.org."], False, "a trailing dot"),
        ("reject-one-letter-tld", [RELAYS_A[0], "wss://relay.example.o"], False, "a one-letter last label"),
        ("reject-leading-hyphen", [RELAYS_A[0], "wss://-relay.example.org"], False, "a label starting with a hyphen"),
        ("reject-userinfo", [RELAYS_A[0], "wss://user@relay.example.org"], False, "user info"),
        ("reject-query", [RELAYS_A[0], "wss://relay.example.org/?a=1"], False, "a query"),
        ("reject-fragment", [RELAYS_A[0], "wss://relay.example.org/#x"], False, "a fragment"),
        ("reject-port-zero", [RELAYS_A[0], "wss://relay.example.org:0"], False, "port 0"),
        ("reject-port-leading-zero", [RELAYS_A[0], "wss://relay.example.org:0443"], False, "a port with a leading zero"),
        ("reject-port-65536", [RELAYS_A[0], "wss://relay.example.org:65536"], False, "port 65536"),
        ("reject-percent", [RELAYS_A[0], "wss://relay%2eexample.org"], False, "percent-encoding"),
        ("reject-fullwidth-dot", [RELAYS_A[0], "wss://relay。example.org"], False, "a non-ASCII (ideographic) full stop"),
        ("reject-whitespace", [RELAYS_A[0], "wss://relay.example.org "], False, "trailing whitespace"),
        ("reject-backslash", [RELAYS_A[0], "wss://relay.example.org\\x"], False, "a backslash"),
        ("reject-257-chars", [RELAYS_A[0], "wss://relay.example.org/" + "a" * 233], False, "257 characters (at most 256)"),
    ]:
        if case_id == "reject-257-chars" and len(relays[1]) != 257:
            v.fail("the 257-character URL has the wrong length")
        case(f"relays-{case_id}", "parseRelayList", f"{rl}: {why}", relays, accept)
    url256 = "wss://relay.example.org/" + "a" * 232
    if len(url256) != 256:
        v.fail("the 256-character URL has the wrong length")
    case("relays-accept-256-chars", "parseRelayList", f"{rl}: a URL of exactly 256 characters", [RELAYS_A[0], url256], True)
    return cases


BODY_OPS = ("parseInvite", "parseHandshake", "parseHandshakeAck", "parseCardUpdate")
SCHEMA = v.case_schema(
    SUITE,
    "04 §3.4, §3.4.1, §3.6 (G-23, G-24, G-28): the strict schema of each pairing body, and of a relay "
    "list carried with a card. `outcome` is accept or reject; signatures, hashes, the proof and the "
    "commitment are not checked here (M1-7c, safety-code-recompute).",
    {
        **{op: ({"body": v.ANY}, [v.ACCEPT, v.REJECT]) for op in BODY_OPS},
        "parseRelayList": ({"relays": v.ANY}, [v.ACCEPT, v.REJECT]),
    },
)

if __name__ == "__main__":
    v.main(
        suite=SUITE,
        version=VERSION,
        script="tools/vectors/generate_pairing_bodies.py",
        libraries=["cryptography", "coincurve", "pycryptodome", "rfc8785"],
        build=build,
        schema=SCHEMA,
        doc=__doc__,
    )
