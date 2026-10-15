#!/usr/bin/env python3
"""Independent generator for the `terms` suite: `terms`, `termsHash`, `TermsInput` and the negotiation chain (M1-21).

Written from the spec only (04 §2.4.1, §3.1, §3.4 with the D-74 clarifications; 06 §2.2a with the
D-74 TermsInput rules; D-32, D-55, D-74), by a session that does not implement the TypeScript schema,
under the M1-1h rules. Nothing here reads `@agentlink/types`.

What the spec fixes (04 §3.4, D-74):
  terms       {termsId, version, parties, subject, deliverables[{id, description, by, plaintextSha256}],
               price, deadlines[{ref, due}], validUntil, previousTermsHash}; every key always present;
               `null` only for `price`, `plaintextSha256` and `previousTermsHash` (and the body's `note`).
  termsHash = sha256(JCS(terms)), RFC 8785, 64 lowercase hex, no prefix (04 §2.4.1).
  Encodings (04 §2.4.1): `termsId` base64url of 16 bytes; `parties[]`, `by`, `payer` 0x + 40 lowercase
  hex; `plaintextSha256`, `previousTermsHash`, `termsHash` 64 lowercase hex; integer tokens
  `0|[1-9][0-9]*`.
  `parties`: two distinct agent IDs in ascending byte order. `version` 1 exactly when
  `previousTermsHash` is null (a parse rule).
  Characters: every string of `terms` and a non-null `note` is NFC and has no code point whose UCD
  15.0.0 General_Category is Cc, Cf, Zl, Zp, Co, Cs or Cn.
  Limits: subject 1-200 code points; 1-10 deliverables; ids ^[A-Za-z0-9_-]{1,16}$; descriptions 1-160
  code points; 0-10 deadlines; amount ^(0|[1-9][0-9]{0,17})(\\.[0-9]{1,6})?$ and > 0; note null or
  1-500 code points; version and validUntil 1 to 2^53 - 1; no empty strings.
  Currency: ^[A-Z]{3}$ or exactly USDC, USDT, XDAI. Dates: real Gregorian, no leap second. Deadline
  refs name a deliverable and are unique.
  Chain (D-55, D-74): key = termsId + unordered pair; a received offer is valid only when version =
  newest + 1 and previousTermsHash = newest hash; rules 1-4 (no forks); duplicates dropped first;
  rule 1 compares envelopes by envelopeHash; answers name their offer by replyTo and copy its terms;
  a received answer is timely when its signed createdAt <= validUntil; anchored resends after a
  conflict (items 1-4), with rule 2 (lock) taking precedence.

Unicode categories. The rule is pinned to UCD 15.0.0. This generator takes General_Category from
Python's `unicodedata` when it is exactly 15.0.0 (CPython 3.12, which CI runs). Under 15.1.0 (CPython
3.13) it treats the code points that Unicode 15.1 added (U+2EBF0..U+2EE5D CJK Extension I, U+2FFC..
U+2FFF and U+31EF, the 627 characters of 15.1) as Cn, which is their 15.0.0 category. Any other
Unicode version stops the generator. CI's `--check` under 3.12 therefore rechecks every case against
the 15.0.0 data itself. NFC uses `unicodedata` normalisation; for code points assigned in 15.0.0 it is
the same in every later version (normalisation stability), and strings with unassigned code points
are refused before NFC matters.

The reference parser and the reference chain model below are this generator's own reading of the
spec (Python `re`, `unicodedata`, `calendar`). Every case's declared outcome is checked against them,
so a case that the reference disagrees with stops the generator. Hashes come from `rfc8785` and are
cross-checked against a second JCS serialisation written out here (sorted ASCII keys, no whitespace,
which equals RFC 8785 for these shapes: no floats, ASCII keys).

Ops (the harness module maps each to the code under test):
  parseTerms       {terms}                          -> accept + termsHash | reject
  parseTermsJson   {json}  (raw JSON text)          -> accept + termsHash | reject
  parseTermsBody   {type, body} (offer/accept/reject body) -> accept + termsHash | reject
  parseTermsInput  {termsInput, now}                -> accept | reject
  mapTermsInput    {termsInput, context}            -> termsHash + termsJcs (the mapped terms)
  unicodeProbe     {probe}                          -> nfc (the NFC form a Unicode 15.0+ runtime gives)
  chainReceive     {self, now, log, incoming}       -> valid | refused | conflict | duplicate, plus the
                                                       newest version and termsHash of the incoming's key
  nextOffer        {self, contact, termsId, log}    -> version, previousTermsHash and replyTo a sending
                                                       core sets ("null" when not a resend)
  sendAccept       {self, now, log, answers}        -> allowed + termsHash | refused
Chain cases model envelopes abstractly: `{id, from, to, createdAt, type, replyTo, body}` with `from`
and `to` as agent IDs (the core maps the envelope's Nostr `from` to the contact's agent ID). Two
abstract envelopes are the same envelope (the same envelopeHash) exactly when every field is equal;
the same `id` with other content is a different envelope. `log` is the ordered history of envelopes
the core has sent and received for this pair; the core replays it to build its state (refused and
conflicting envelopes stay in the log, as the core stores them). `now` is the core's own clock in
unix seconds. "null" in an expected field means JSON null; "0" as newestVersion means no valid offer
exists for that key. An offer's `replyTo` is null except on a resend after a conflict.

Not covered here: the SHA-256 of the pinned UCD 15.0.0 `DerivedGeneralCategory.txt` (the generator
does not hold that file) and a lone surrogate (the harness JSON loader refuses one in a vector file,
see generate_pairing_bodies.py).

Usage: python3 -I tools/vectors/generate_terms.py --check [FILE] | --write
"""

import calendar
import copy
import json
import re
import sys
import unicodedata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import vectorlib as v  # noqa: E402

SUITE = "terms"
VERSION = 1
MAX_INT = 2**53 - 1
NOW = 1790000000
WEEK = 7 * 86400

S_TERMS = "04 §3.4 terms (D-32)"
S_CANON = "04 §3.4 canonical form (D-55)"
S_KEYS = "04 §3.4 D-74 key presence"
S_PARTIES = "04 §3.4 D-74 parties order"
S_CHARS = "04 §3.4 D-74 characters (UCD 15.0.0)"
S_SIZE = "04 §3.4 D-74 size limits"
S_CUR = "04 §3.4 D-74 currency"
S_DATES = "04 §3.4 D-74 dates"
S_REFS = "04 §3.4 D-74 deadline references"
S_VER = "04 §3.4 D-74 version and pointer"
S_ENC = "04 §2.4.1 canonical encodings"
S_HASH = "04 §3.4 termsHash = sha256(JCS(terms)), 04 §3.1 RFC 8785"
S_BODY = "04 §3.4 body of offer / accept / reject"
S_INPUT = "06 §2.2a TermsInput, D-74 TermsInput rules"
S_PROBE = "04 §3.4 D-74 runtime check"
S_CHAIN = "04 §3.4 negotiation chain (D-55)"
S_ANSWER = "04 §3.4 D-74 how an answer names its offer"
S_VALID = "04 §3.4 D-74 validity boundary"
S_AFTER = "04 §3.4 D-74 after an accept"
S_DUP = "04 §3.4 D-74 duplicates"
S_RESEND = "04 §3.4 D-74 resending after a conflict"
S_ACCEPT = "04 §3.4 sending an accept (D-55)"


# --- Unicode 15.0.0 categories --------------------------------------------------------------------

UNICODE_15_1_ADDITIONS = ((0x2EBF0, 0x2EE5D), (0x2FFC, 0x2FFF), (0x31EF, 0x31EF))


def category_15_0(ch):
    version = unicodedata.unidata_version
    if version == "15.0.0":
        return unicodedata.category(ch)
    if version == "15.1.0":
        cp = ord(ch)
        if any(lo <= cp <= hi for lo, hi in UNICODE_15_1_ADDITIONS):
            return "Cn"
        return unicodedata.category(ch)
    v.fail(f"Python's unicodedata is Unicode {version}; this generator needs 15.0.0 or 15.1.0")


def check_unicode_tables():
    for lo, hi in UNICODE_15_1_ADDITIONS:
        for cp in (lo, hi):
            native = unicodedata.category(chr(cp))
            if unicodedata.unidata_version == "15.1.0" and native == "Cn":
                v.fail(f"U+{cp:04X} should be assigned in Unicode 15.1")
            if unicodedata.unidata_version == "15.0.0" and native != "Cn":
                v.fail(f"U+{cp:04X} should be unassigned in Unicode 15.0")


# --- the reference parser (04 §2.4.1, §3.4, D-74) ------------------------------------------------

TERMS_KEYS = {"termsId", "version", "parties", "subject", "deliverables", "price", "deadlines", "validUntil", "previousTermsHash"}
DELIVERABLE_KEYS = {"id", "description", "by", "plaintextSha256"}
PRICE_KEYS = {"amount", "currency", "payer"}
DEADLINE_KEYS = {"ref", "due"}
REFUSED_CATEGORIES = {"Cc", "Cf", "Zl", "Zp", "Co", "Cs", "Cn"}
TOKENS = {"USDC", "USDT", "XDAI"}
AMOUNT = re.compile(r"(0|[1-9][0-9]{0,17})(\.[0-9]{1,6})?")
DUE = re.compile(r"([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})Z")
ADDRESS = re.compile(r"0x[0-9a-f]{40}")
HEX64 = re.compile(r"[0-9a-f]{64}")
DELIVERABLE_ID = re.compile(r"[A-Za-z0-9_-]{1,16}")


def check_string(value):
    """The D-74 character rule: no code point of a refused UCD 15.0.0 category, and NFC."""
    if not isinstance(value, str) or value == "":
        raise ValueError("not a non-empty string")
    for ch in value:
        if category_15_0(ch) in REFUSED_CATEGORIES:
            raise ValueError("refused character")
    if not unicodedata.is_normalized("NFC", value):
        raise ValueError("not NFC")
    return value


def check_text(value, maximum):
    check_string(value)
    if len(value) > maximum:  # Python str length = code points
        raise ValueError("too long")
    return value


def check_integer(value, minimum=1):
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= MAX_INT:
        raise ValueError("not a JSON integer in range")
    return value


def check_due(value):
    check_string(value)
    m = DUE.fullmatch(value)
    if not m:
        raise ValueError("due: not YYYY-MM-DDTHH:MM:SSZ")
    year, month, day, hour, minute, second = (int(g) for g in m.groups())
    if not 1 <= month <= 12 or not 1 <= day <= calendar.monthrange(year, month)[1]:
        raise ValueError("due: no such date")
    if hour > 23 or minute > 59 or second > 59:
        raise ValueError("due: no such time")
    return calendar.timegm((year, month, day, hour, minute, second))


def check_amount(value):
    check_string(value)
    if not AMOUNT.fullmatch(value) or set(value) <= {"0", "."}:
        raise ValueError("amount: not a positive canonical decimal within 18 + 6 digits")
    return value


def check_currency(value):
    check_string(value)
    if not (re.fullmatch(r"[A-Z]{3}", value) or value in TOKENS):
        raise ValueError("currency")
    return value


def check_hex64(value):
    check_string(value)
    if not HEX64.fullmatch(value):
        raise ValueError("not 64 lowercase hex")
    return value


def exact_keys(obj, keys):
    if not isinstance(obj, dict) or set(obj) != set(keys):
        raise ValueError("wrong keys")


def check_deliverable_id(value):
    check_string(value)
    if not DELIVERABLE_ID.fullmatch(value):
        raise ValueError("deliverable id")
    return value


def check_deadlines(deadlines, ids):
    if not isinstance(deadlines, list) or len(deadlines) > 10:
        raise ValueError("deadlines: not a list of 0 to 10")
    refs = []
    for dl in deadlines:
        exact_keys(dl, DEADLINE_KEYS)
        check_string(dl["ref"])
        if dl["ref"] not in ids:
            raise ValueError("ref: no such deliverable")
        check_due(dl["due"])
        refs.append(dl["ref"])
    if len(set(refs)) != len(refs):
        raise ValueError("refs: duplicate")


def parse_terms(terms):
    exact_keys(terms, TERMS_KEYS)
    check_string(terms["termsId"])
    if len(v.unb64u(terms["termsId"])) != 16:
        raise ValueError("termsId: not 16 bytes")
    check_integer(terms["version"])
    parties = terms["parties"]
    if not isinstance(parties, list) or len(parties) != 2:
        raise ValueError("parties: not two")
    for p in parties:
        check_string(p)
        if not ADDRESS.fullmatch(p):
            raise ValueError("party: not 0x + 40 lowercase hex")
    if not bytes.fromhex(parties[0][2:]) < bytes.fromhex(parties[1][2:]):
        raise ValueError("parties: not distinct and in ascending byte order")
    check_text(terms["subject"], 200)
    deliverables = terms["deliverables"]
    if not isinstance(deliverables, list) or not 1 <= len(deliverables) <= 10:
        raise ValueError("deliverables: not 1 to 10")
    ids = []
    for d in deliverables:
        exact_keys(d, DELIVERABLE_KEYS)
        check_deliverable_id(d["id"])
        check_text(d["description"], 160)
        check_string(d["by"])
        if d["by"] not in parties:
            raise ValueError("by: not a party")
        if d["plaintextSha256"] is not None:
            check_hex64(d["plaintextSha256"])
        ids.append(d["id"])
    if len(set(ids)) != len(ids):
        raise ValueError("deliverables: duplicate id")
    price = terms["price"]
    if price is not None:
        exact_keys(price, PRICE_KEYS)
        check_amount(price["amount"])
        check_currency(price["currency"])
        check_string(price["payer"])
        if price["payer"] not in parties:
            raise ValueError("payer: not a party")
    check_deadlines(terms["deadlines"], ids)
    check_integer(terms["validUntil"])
    prev = terms["previousTermsHash"]
    if prev is not None:
        check_hex64(prev)
    if (terms["version"] == 1) != (prev is None):
        raise ValueError("version 1 exactly when previousTermsHash is null")
    return terms


def strict_json(text):
    """Strict JSON text: integer tokens `-?(0|[1-9][0-9]*)` only (then range-checked by the schema),
    no fraction or exponent, no NaN or Infinity, no duplicate keys (I-JSON)."""

    def no_float(token):
        raise ValueError(f"number token {token} is not an integer token")

    def int_token(token):
        if token == "-0":
            raise ValueError("-0")
        return int(token)

    def pairs(items):
        keys = [k for k, _ in items]
        if len(set(keys)) != len(keys):
            raise ValueError("duplicate key")
        return dict(items)

    return json.loads(text, parse_float=no_float, parse_int=int_token, parse_constant=no_float, object_pairs_hook=pairs)


def jcs(value):
    out = v.jcs(value)
    # Cross-check: for objects with ASCII keys and no floats, RFC 8785 is sorted keys, no whitespace,
    # UTF-8 strings with the JSON short escapes; json.dumps with these settings gives the same bytes.
    alt = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    if out != alt:
        v.fail("rfc8785 disagrees with the written-out JCS")
    return out


def terms_hash(terms):
    return v.hx(v.sha256(jcs(terms)))


def accepts(fn, *args):
    try:
        fn(*args)
        return True
    except (ValueError, KeyError, TypeError):
        return False


# --- body (04 §3.4) ------------------------------------------------------------------------------


def parse_body(type_, body):
    if type_ not in ("offer", "accept", "reject"):
        raise ValueError("type")
    exact_keys(body, {"terms", "termsHash", "note"})
    parse_terms(body["terms"])
    if not isinstance(body["termsHash"], str) or not HEX64.fullmatch(body["termsHash"]):
        raise ValueError("termsHash: not 64 lowercase hex")
    if body["termsHash"] != terms_hash(body["terms"]):
        raise ValueError("termsHash mismatch")
    note = body["note"]
    if note is not None:
        if type_ == "accept":
            raise ValueError("note on an accept")
        check_text(note, 500)
    return body["termsHash"]


# --- TermsInput (06 §2.2a, D-74) and its mapping --------------------------------------------------

INPUT_KEYS = {"subject", "deliverables", "price", "deadlines", "validUntil"}


def no_nulls(obj):
    if obj is None:
        raise ValueError("explicit null")
    if isinstance(obj, dict):
        for value in obj.values():
            no_nulls(value)
    if isinstance(obj, list):
        for value in obj:
            no_nulls(value)


def parse_input(ti, now):
    if not isinstance(ti, dict) or not set(ti) <= INPUT_KEYS or not {"subject", "deliverables"} <= set(ti):
        raise ValueError("keys")
    no_nulls(ti)
    check_text(ti["subject"], 200)
    ds = ti["deliverables"]
    if not isinstance(ds, list) or not 1 <= len(ds) <= 10:
        raise ValueError("deliverables")
    with_ids = [("id" in d) if isinstance(d, dict) else False for d in ds]
    if any(with_ids) and not all(with_ids):
        raise ValueError("ids: every deliverable or none")
    ids = []
    for i, d in enumerate(ds):
        if not isinstance(d, dict) or not set(d) <= DELIVERABLE_KEYS or not {"description", "by"} <= set(d):
            raise ValueError("deliverable keys")
        check_text(d["description"], 160)
        if d["by"] not in ("me", "them"):
            raise ValueError("by")
        if "plaintextSha256" in d:
            check_hex64(d["plaintextSha256"])
        ids.append(check_deliverable_id(d["id"]) if "id" in d else f"d{i + 1}")
    if len(set(ids)) != len(ids):
        raise ValueError("duplicate id")
    if "price" in ti:
        p = ti["price"]
        exact_keys(p, PRICE_KEYS)
        check_amount(p["amount"])
        check_currency(p["currency"])
        if p["payer"] not in ("me", "them"):
            raise ValueError("payer")
    if "deadlines" in ti:
        check_deadlines(ti["deadlines"], ids)
    if "validUntil" in ti and check_due(ti["validUntil"]) <= now:
        raise ValueError("validUntil: not after now")
    return ti


def map_input(ti, ctx):
    parse_input(ti, ctx["now"])
    who = {"me": ctx["me"], "them": ctx["them"]}
    deliverables = [
        {"id": d.get("id", f"d{i + 1}"), "description": d["description"], "by": who[d["by"]], "plaintextSha256": d.get("plaintextSha256")}
        for i, d in enumerate(ti["deliverables"])
    ]
    p = ti.get("price")
    terms = {
        "termsId": ctx["termsId"],
        "version": ctx["version"],
        "parties": sorted([ctx["me"], ctx["them"]]),
        "subject": ti["subject"],
        "deliverables": deliverables,
        "price": None if p is None else {"amount": p["amount"], "currency": p["currency"], "payer": who[p["payer"]]},
        "deadlines": [dict(dl) for dl in ti.get("deadlines", [])],
        "validUntil": check_due(ti["validUntil"]) if "validUntil" in ti else ctx["now"] + WEEK,
        "previousTermsHash": ctx["previousTermsHash"],
    }
    parse_terms(terms)
    return terms


# --- the reference chain model (04 §3.4, D-55, D-74) ----------------------------------------------


class Chain:
    """One core's view, replayed from its log. Per key (termsId, unordered pair): the live offer for
    each version, the first envelope seen per (sender, version), locked versions, the latest conflict
    per version (one envelope id per side, and who has resent since), and the offers this core
    accepted."""

    def __init__(self, me):
        self.me = me
        self.keys = {}
        self.by_id = {}
        self.seen = []

    def state(self, key):
        return self.keys.setdefault(key, {"live": {}, "senders": {}, "locked": set(), "conflict": {}, "accepted": set()})

    @staticmethod
    def key_of(terms):
        return (terms["termsId"], frozenset(terms["parties"]))

    def newest(self, key):
        live = self.state(key)["live"]
        if not live:
            return 0, None
        version = max(live)
        return version, live[version]["hash"]

    def is_live(self, env):
        terms = env["body"]["terms"]
        rec = self.state(self.key_of(terms))["live"].get(terms["version"])
        return rec is not None and rec["env"] is env

    def apply(self, direction, env):
        if any(env == e for e in self.seen):
            return "duplicate"  # D-74 duplicates: dropped before the chain rules
        self.seen.append(env)
        status = self._apply(direction, env)
        self.by_id.setdefault(env["id"], env)
        return status

    def _apply(self, direction, env):
        body, type_ = env["body"], env["type"]
        try:
            parse_body(type_, body)
        except (ValueError, KeyError, TypeError):
            return "refused"
        terms = body["terms"]
        sender, receiver = env["from"], env["to"]
        if set(terms["parties"]) != {sender, receiver} or self.me not in (sender, receiver) or sender == receiver:
            return "refused"
        st = self.state(self.key_of(terms))
        n, h, prev = terms["version"], body["termsHash"], terms["previousTermsHash"]
        rec = {"hash": h, "from": sender, "id": env["id"], "prev": prev, "env": env}
        if type_ == "offer":
            if direction == "sent":
                st["live"][n] = rec
                st["senders"].setdefault((sender, n), env["id"])
                if n in st["conflict"]:
                    st["conflict"][n]["resent"].add(self.me)
                return "valid"
            return self._receive_offer(st, env, sender, n, prev, rec)
        return self._answer(direction, st, env, sender, receiver, n, h)

    def _receive_offer(self, st, env, sender, n, prev, rec):
        if n in st["locked"]:
            return "refused"  # rule 2 takes precedence over everything below
        own = st["live"].get(n)
        own = own if own is not None and own["from"] == self.me else None
        reply_to = env["replyTo"]
        if reply_to is not None:
            base_hash = st["live"][n - 1]["hash"] if n > 1 and (n - 1) in st["live"] else None
            pointer_ok = prev == base_hash and (n == 1 or (n - 1) in st["live"])
            # item 1: names the receiver's own live envelope for n, not yet seen in a conflict
            if own is not None and reply_to == own["id"]:
                if not pointer_ok:
                    return "refused"
                st["conflict"][n] = {"pair": {self.me: own["id"], sender: None}, "resent": {sender}}
                st["live"][n] = rec
                return "valid"
            # item 2: the sender's first resend after the latest conflict, naming the other side's envelope
            c = st["conflict"].get(n)
            if c is not None and sender not in c["resent"] and reply_to == c["pair"][self.me]:
                if not pointer_ok or max(st["live"], default=0) > n:
                    return "refused"
                c["resent"].add(sender)
                if own is not None:  # item 4: two resends, one from each side: a new conflict
                    del st["live"][n]
                    st["conflict"][n] = {"pair": {self.me: own["id"], sender: env["id"]}, "resent": set()}
                    return "conflict"
                st["live"][n] = rec
                return "valid"
            return "refused"  # item 3, or a second resend (rule 1)
        if n in st["conflict"]:
            return "refused"  # item 2: no link after a conflict
        if (sender, n) in st["senders"]:
            return "refused"  # rule 1
        newest_v, newest_h = self.newest_key(st)
        if own is not None and newest_v == n and own["prev"] == prev:
            # rule 3: concurrent counters; the previous version stays newest
            del st["live"][n]
            st["conflict"][n] = {"pair": {self.me: own["id"], sender: env["id"]}, "resent": set()}
            return "conflict"
        if n == newest_v + 1 and prev == newest_h:
            st["live"][n] = rec
            st["senders"][(sender, n)] = env["id"]
            return "valid"
        return "refused"

    @staticmethod
    def newest_key(st):
        if not st["live"]:
            return 0, None
        version = max(st["live"])
        return version, st["live"][version]["hash"]

    def _answer(self, direction, st, env, sender, receiver, n, h):
        offer = self.by_id.get(env["replyTo"])
        if offer is None or offer["type"] != "offer" or not self.is_live(offer):
            return "refused"
        if offer["body"]["terms"] != env["body"]["terms"] or offer["body"]["termsHash"] != h:
            return "refused"  # an answer copies its offer's terms exactly
        if direction == "received" and env["createdAt"] > offer["body"]["terms"]["validUntil"]:
            return "refused"  # judged by the signed createdAt, never the receiver's clock
        if offer["from"] == receiver and offer["to"] == sender:
            if env["type"] == "accept":
                if n in st["locked"]:
                    return "refused"  # rule 2: one accept per version
                st["locked"].add(n)
                if sender == self.me:
                    st["accepted"].add(offer["id"])
            return "valid"
        if env["type"] == "reject" and offer["from"] == sender and offer["to"] == receiver and offer["id"] in st["accepted"]:
            return "valid"  # 06 §2.2a path (b): the reject names the sender's own offer
        return "refused"

    def replay(self, log):
        for entry in log:
            self.apply(entry["dir"], entry["envelope"])
        return self


def chain_receive(me, log, incoming):
    chain = Chain(me).replay(log)
    outcome = chain.apply("received", incoming)
    version, h = chain.newest(Chain.key_of(incoming["body"]["terms"]))
    return outcome, version, h


def next_offer(me, contact, terms_id, log):
    chain = Chain(me).replay(log)
    key = (terms_id, frozenset({me, contact}))
    version, h = chain.newest(key)
    c = chain.state(key)["conflict"].get(version + 1)
    reply_to = c["pair"].get(contact) if c is not None and me not in c["resent"] else None
    return version + 1, h, reply_to


def send_accept(me, now, log, answers):
    chain = Chain(me).replay(log)
    offer = chain.by_id.get(answers)
    if offer is None or offer["type"] != "offer" or offer["to"] != me or not chain.is_live(offer):
        return None
    terms = offer["body"]["terms"]
    key = Chain.key_of(terms)
    newest_v, newest_h = chain.newest(key)
    if terms["version"] != newest_v or offer["body"]["termsHash"] != newest_h:
        return None  # superseded
    if terms["version"] in chain.state(key)["locked"]:
        return None
    if now > terms["validUntil"]:
        return None
    return offer["body"]["termsHash"]


# --- fixtures ------------------------------------------------------------------------------------

A = v.evm_address(v.det("terms/agent-a", 32))
B = v.evm_address(v.det("terms/agent-b", 32))
C = v.evm_address(v.det("terms/agent-c", 32))
AB = sorted([A, B])
AC = sorted([A, C])
TID = v.b64u(v.det("terms/terms-id/1", 16))
TID2 = v.b64u(v.det("terms/terms-id/2", 16))
B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
DIGEST = v.hx(v.sha256(b"agentlink-test-vectors/terms/d2-plaintext"))
DIGEST2 = v.hx(v.sha256(b"agentlink-test-vectors/terms/previous"))
VALID_UNTIL = NOW + WEEK
VALID_UNTIL_TEXT = "2026-09-28T14:13:20Z"


def base_terms(**over):
    t = {
        "termsId": TID,
        "version": 1,
        "parties": list(AB),
        "subject": "Spec v2 \u2013 milestone 3",
        "deliverables": [
            {"id": "d1", "description": "Milestone 3 report", "by": B, "plaintextSha256": None},
            {"id": "d2", "description": "Review of the report", "by": A, "plaintextSha256": DIGEST},
        ],
        "price": {"amount": "1500.00", "currency": "EUR", "payer": A},
        "deadlines": [{"ref": "d1", "due": "2026-11-30T17:00:00Z"}],
        "validUntil": VALID_UNTIL,
        "previousTermsHash": None,
    }
    t.update(over)
    return t


def with_path(terms, path, value, delete=False):
    """A copy with the value at `path` (a list of keys and indices) replaced, or deleted."""
    t = copy.deepcopy(terms)
    node = t
    for p in path[:-1]:
        node = node[p]
    if delete:
        del node[path[-1]]
    else:
        node[path[-1]] = value
    return t


def body_of(terms, note=None):
    return {"terms": terms, "termsHash": terms_hash(terms), "note": note}


def env(label, sender, to, type_, terms, reply_to=None, note=None, created_at=NOW):
    return {
        "id": v.b64u(v.det(f"terms/envelope/{label}", 16)),
        "from": sender,
        "to": to,
        "createdAt": created_at,
        "type": type_,
        "replyTo": reply_to,
        "body": body_of(terms, note),
    }


def sent(e):
    return {"dir": "sent", "envelope": e}


def received(e):
    return {"dir": "received", "envelope": e}


def many(n, label):
    deliverables = [{"id": f"{label}{i + 1}", "description": f"Item {i + 1}", "by": AB[i % 2], "plaintextSha256": None} for i in range(n)]
    deadlines = [{"ref": d["id"], "due": f"2026-12-{i + 1:02d}T12:00:00Z"} for i, d in enumerate(deliverables)]
    return deliverables, deadlines


# --- cases ---------------------------------------------------------------------------------------


def build():
    v.check_eip55()  # the pinned keccak agrees with the published EIP-55 examples
    check_unicode_tables()
    if AB[0] == AB[1] or AC[0] == AC[1]:
        v.fail("fixture agents collide")
    cases = []

    def add(case_id, source, input_, expected):
        cases.append(v.case(case_id, source, input_, expected))

    base = base_terms()
    base_hash = terms_hash(base)

    def terms_case(case_id, source, terms, accept):
        ok = accepts(parse_terms, terms)
        if ok != accept:
            v.fail(f"{case_id}: the reference parser {'accepts' if ok else 'rejects'} it")
        expected = {"outcome": "accept", "termsHash": terms_hash(terms)} if accept else {"outcome": "reject"}
        add(f"terms-{case_id}", source, {"op": "parseTerms", "terms": terms}, expected)

    # 1. Canonical inputs and their hashes.
    terms_case("accept-base", f"{S_TERMS}: every field canonical, price and one deadline; {S_HASH}", base, True)
    minimal = base_terms(price=None, deadlines=[], deliverables=[base["deliverables"][0]])
    terms_case("accept-minimal", f"{S_KEYS}: price null and deadlines [] when there are none; one deliverable", minimal, True)
    v2 = base_terms(version=2, previousTermsHash=base_hash, subject="Spec v2 \u2013 milestone 3 (counter)")
    terms_case("accept-version-2", f"{S_VER}: version 2 with a pointer", v2, True)
    terms_case("accept-unicode", f"{S_CHARS}: NFC text with a precomposed \u00e9, CJK, an astral emoji, U+FE0F (Mn), a no-break space (Zs) and a ligature (NFC, not NFKC)", with_path(base, ["subject"], "Caf\u00e9 \u5951\u7d04 \U0001f91d\ufe0f\u00a0\ufb01nal"), True)
    terms_case("accept-unicode-15-0", f"{S_CHARS}: U+31350, a CJK Extension H ideograph assigned in Unicode 15.0", with_path(base, ["subject"], "x\U00031350y"), True)
    terms_case("accept-nfc-order-15-0", f"{S_CHARS}, {S_PROBE}: x + U+10EFD (new in 15.0, ccc 220) + U+0301 (ccc 230) is NFC", with_path(base, ["subject"], "x\U00010efd\u0301"), True)
    for slug, value, why in [
        ("integer", "1", "\"1\""),
        ("6-decimals", "0.000001", "\"0.000001\" (6 decimals, > 0)"),
        ("trailing-zeros", "1500.000000", "\"1500.000000\" keeps its trailing zeros (04 §2.4.1 Other decimal amounts)"),
        ("max-digits", "9" * 18 + "." + "9" * 6, "18 digits before the point and 6 after it"),
    ]:
        terms_case(f"accept-amount-{slug}", f"{S_SIZE}, {S_CANON}: amount {why}", with_path(base, ["price", "amount"], value), True)
    for value, why in [("USD", "USD"), ("ABC", "ABC (a grammar, not the ISO 4217 list)"), ("DAI", "DAI (passes the grammar)"), ("USDC", "the token USDC"), ("USDT", "the token USDT"), ("XDAI", "the token XDAI")]:
        terms_case(f"accept-currency-{value.lower()}", f"{S_CUR}: {why}", with_path(base, ["price", "currency"], value), True)
    terms_case("accept-due-leap-day", f"{S_DATES}: due 2028-02-29T00:00:00Z (a leap day)", with_path(base, ["deadlines", 0, "due"], "2028-02-29T00:00:00Z"), True)
    terms_case("accept-valid-until-1", f"{S_SIZE}: validUntil 1 (expiry is a chain check)", with_path(base, ["validUntil"], 1), True)
    terms_case("accept-valid-until-max", f"{S_SIZE}: validUntil 2^53 - 1", with_path(base, ["validUntil"], MAX_INT), True)
    terms_case("accept-version-max", f"{S_SIZE}, {S_VER}: version 2^53 - 1 with a pointer", base_terms(version=MAX_INT, previousTermsHash=DIGEST2), True)
    astral = "\U0001d400"
    terms_case("accept-subject-200", f"{S_SIZE}: subject of 200 code points (210 UTF-16 units)", with_path(base, ["subject"], astral * 10 + "s" * 190), True)
    terms_case("accept-description-160", f"{S_SIZE}: description of 160 code points (170 UTF-16 units)", with_path(base, ["deliverables", 0, "description"], astral * 10 + "d" * 150), True)
    terms_case("accept-id-16", f"{S_SIZE}: a deliverable id of 16 characters from [A-Za-z0-9_-]", with_path(with_path(base, ["deliverables", 0, "id"], "Ab_-0123456789zZ"), ["deadlines", 0, "ref"], "Ab_-0123456789zZ"), True)
    ds10, dl10 = many(10, "d")
    terms_case("accept-10-deliverables-10-deadlines", f"{S_SIZE}: 10 deliverables and 10 deadlines with unique refs", base_terms(deliverables=ds10, deadlines=dl10), True)
    terms_case("accept-subject-space", f"{S_SIZE}: a subject of one space is not empty", with_path(base, ["subject"], " "), True)

    # 2. Every covered field changes the hash (each a valid variant of terms-accept-version-2).
    variants = [
        ("terms-id", ["termsId"], TID2),
        ("version", ["version"], 3),
        ("subject", ["subject"], "Spec v2 \u2013 milestone 4"),
        ("deliverable-id", ["deliverables", 1, "id"], "d3"),
        ("deliverable-description", ["deliverables", 0, "description"], "Milestone 3 report, final"),
        ("deliverable-by", ["deliverables", 0, "by"], A),
        ("deliverable-plaintext-sha256", ["deliverables", 0, "plaintextSha256"], DIGEST),
        ("deliverables-order", ["deliverables"], list(reversed(v2["deliverables"]))),
        ("price-amount", ["price", "amount"], "1500.0"),
        ("price-currency", ["price", "currency"], "USD"),
        ("price-payer", ["price", "payer"], B),
        ("price-null", ["price"], None),
        ("deadline-due", ["deadlines", 0, "due"], "2026-11-30T17:00:01Z"),
        ("deadline-ref", ["deadlines", 0, "ref"], "d2"),
        ("deadlines-empty", ["deadlines"], []),
        ("valid-until", ["validUntil"], VALID_UNTIL + 1),
        ("previous-terms-hash", ["previousTermsHash"], DIGEST2),
    ]
    hashes = {terms_hash(v2)}
    for slug, path, value in variants:
        t = with_path(v2, path, value)
        h = terms_hash(t)
        if h in hashes:
            v.fail(f"covered field {slug}: the hash did not change")
        hashes.add(h)
        terms_case(f"accept-changed-{slug}", f"{S_HASH}: a covered field changes the hash ({slug} differs from terms-accept-version-2)", t, True)

    # 3. Character rejections (04 §3.4, D-74) on each string path.
    reject_strings = [
        ("rlo-subject", ["subject"], "Spec v2 \u202emilestone 3", "U+202E RIGHT-TO-LEFT OVERRIDE (Cf) in subject"),
        ("zwsp-description", ["deliverables", 0, "description"], "Milestone\u200b3 report", "U+200B ZERO WIDTH SPACE (Cf) in a deliverable description"),
        ("cyrillic-currency", ["price", "currency"], "\u0415UR", "Cyrillic \u0415UR (U+0415) as currency"),
        ("nul-subject", ["subject"], "a\u0000b", "U+0000 (Cc)"),
        ("tab-subject", ["subject"], "a\tb", "U+0009 TAB (Cc)"),
        ("newline-description", ["deliverables", 0, "description"], "line one\nline two", "U+000A LINE FEED (Cc) in a description"),
        ("cr-description", ["deliverables", 0, "description"], "a\rb", "U+000D (Cc)"),
        ("us-subject", ["subject"], "a\u001fb", "U+001F (Cc)"),
        ("del-subject", ["subject"], "a\u007fb", "U+007F DELETE (Cc)"),
        ("nel-subject", ["subject"], "a\u0085b", "U+0085 NEXT LINE (Cc, C1)"),
        ("csi-subject", ["subject"], "a\u009b31mb", "U+009B CSI (Cc, C1)"),
        ("line-separator", ["deliverables", 0, "description"], "line\u2028two", "U+2028 LINE SEPARATOR (Zl)"),
        ("paragraph-separator", ["subject"], "a\u2029b", "U+2029 PARAGRAPH SEPARATOR (Zp)"),
        ("zwnj-description", ["deliverables", 0, "description"], "a\u200cb", "U+200C ZERO WIDTH NON-JOINER (Cf)"),
        ("zwj-emoji-subject", ["subject"], "\U0001f468\u200d\U0001f469\u200d\U0001f467", "an emoji ZWJ sequence (U+200D is Cf)"),
        ("word-joiner", ["subject"], "a\u2060b", "U+2060 WORD JOINER (Cf)"),
        ("bom-subject", ["subject"], "\ufeffSpec", "U+FEFF BYTE ORDER MARK (Cf) at the start"),
        ("soft-hyphen", ["subject"], "mile\u00adstone", "U+00AD SOFT HYPHEN (Cf)"),
        ("arabic-letter-mark", ["subject"], "a\u061cb", "U+061C ARABIC LETTER MARK (Cf)"),
        ("mongolian-vowel-separator", ["subject"], "a\u180eb", "U+180E MONGOLIAN VOWEL SEPARATOR (Cf)"),
        ("tag-character", ["subject"], "a\U000e0041b", "U+E0041 TAG LATIN CAPITAL LETTER A (Cf)"),
        ("private-use-bmp", ["subject"], "a\ue000b", "U+E000 (Co)"),
        ("private-use-f8ff", ["deliverables", 0, "description"], "a\uf8ffb", "U+F8FF (Co)"),
        ("private-use-plane-15", ["subject"], "a\U000f0000b", "U+F0000 (Co)"),
        ("private-use-plane-16", ["subject"], "a\U0010fffdb", "U+10FFFD (Co)"),
        ("unassigned", ["subject"], "x\u0378y", "U+0378 (Cn, unassigned)"),
        ("noncharacter-fdd0", ["subject"], "x\ufdd0y", "U+FDD0 (Cn, a noncharacter)"),
        ("noncharacter-fffe", ["deliverables", 0, "description"], "x\ufffey", "U+FFFE (Cn, a noncharacter)"),
        ("noncharacter-10ffff", ["subject"], "x\U0010ffffy", "U+10FFFF (Cn, a noncharacter)"),
        ("unassigned-in-15-0", ["subject"], "x\U0002ebf0y", "U+2EBF0 (Cn in 15.0.0; assigned only in Unicode 15.1)"),
        ("nfc-order-15-0", ["subject"], "x\u0301\U00010efd", "x + U+0301 + U+10EFD: not NFC under Unicode 15.0 (canonical reordering)"),
        ("nfd-subject", ["subject"], "Cafe\u0301", "e + U+0301 (NFD, not NFC)"),
        ("angstrom-sign", ["deliverables", 0, "description"], "5 \u212b", "U+212B ANGSTROM SIGN (NFC maps it to U+00C5)"),
        ("ohm-sign", ["subject"], "10 \u2126", "U+2126 OHM SIGN (NFC maps it to U+03A9)"),
        ("zwsp-amount", ["price", "amount"], "1500\u200b", "U+200B in price.amount"),
    ]
    for cp in [0x200E, 0x200F, 0x202A, 0x202B, 0x202C, 0x202D, 0x202E, 0x2066, 0x2067, 0x2068, 0x2069]:
        reject_strings.append((f"bidi-{cp:04x}", ["subject"], f"Spec {chr(cp)}v2", f"bidi control U+{cp:04X} (Cf) in subject"))
    for slug, path, value, why in reject_strings:
        terms_case(f"reject-{slug}", f"{S_CHARS}: {why}", with_path(base, path, value), False)

    # Sizes and empty strings.
    for slug, path, value, why in [
        ("subject-201", ["subject"], astral * 10 + "s" * 191, "subject of 201 code points"),
        ("subject-empty", ["subject"], "", "an empty subject"),
        ("description-161", ["deliverables", 0, "description"], astral * 10 + "d" * 151, "description of 161 code points"),
        ("description-empty", ["deliverables", 0, "description"], "", "an empty description"),
        ("amount-19-digits", ["price", "amount"], "1" + "0" * 18, "an amount with 19 digits before the point"),
        ("amount-40-digits", ["price", "amount"], "1234567890123456789012345678901234567890.5", "an amount with 40 digits before the point"),
        ("deliverables-empty", ["deliverables"], [], "no deliverables"),
        ("valid-until-zero", ["validUntil"], 0, "validUntil 0 (1 to 2^53 - 1)"),
    ]:
        terms_case(f"reject-{slug}", f"{S_SIZE}: {why}", with_path(base, path, value), False)
    for slug, value, why in [
        ("17", "Ab_-0123456789zZx", "of 17 characters"),
        ("empty", "", "empty"),
        ("dot", "d.1", "with a dot"),
        ("space", "d 1", "with a space"),
        ("non-ascii", "d\u0661", "with an Arabic-Indic digit"),
        ("fullwidth", "\uff44\uff11", "in full-width letters"),
    ]:
        t = with_path(with_path(base, ["deliverables", 0, "id"], value), ["deadlines", 0, "ref"], value)
        terms_case(f"reject-deliverable-id-{slug}", f"{S_SIZE}: a deliverable id {why} (and the ref naming it)", t, False)
    ds11, _ = many(11, "d")
    terms_case("reject-11-deliverables", f"{S_SIZE}: 11 deliverables", base_terms(deliverables=ds11, deadlines=[]), False)
    dl11 = dl10 + [{"ref": "d1", "due": "2027-01-01T00:00:00Z"}]
    terms_case("reject-11-deadlines", f"{S_SIZE}: 11 deadlines (at most 10; the 11th ref also repeats d1)", base_terms(deliverables=ds10, deadlines=dl11), False)

    # Amounts.
    for slug, value, why in [
        ("7-decimals", "1500.0000001", "1500.0000001 (7 decimals)"),
        ("zero", "0", "0 (not greater than zero)"),
        ("zero-point-zero", "0.0", "0.0 (zero)"),
        ("zero-6-decimals", "0.000000", "0.000000 (zero)"),
        ("leading-zero", "01500.00", "a leading zero"),
        ("bare-point", "1500.", "a trailing point"),
        ("leading-point", ".5", "no integer part"),
        ("plus", "+1500", "a sign"),
        ("minus", "-1500", "a negative amount"),
        ("exponent", "1.5e3", "an exponent"),
        ("grouping", "1,500.00", "a grouping comma"),
        ("comma-decimal", "1500,00", "a decimal comma"),
        ("space", " 1500.00", "a leading space"),
        ("fullwidth-digits", "\uff11\uff15\uff10\uff10", "full-width digits"),
        ("arabic-indic-digits", "\u0661\u0665\u0660\u0660", "Arabic-Indic digits (not [0-9])"),
        ("empty", "", "an empty string"),
    ]:
        terms_case(f"reject-amount-{slug}", f"{S_CANON}: price.amount {why}", with_path(base, ["price", "amount"], value), False)
    terms_case("reject-amount-number", f"{S_CANON}: price.amount as a JSON number", with_path(base, ["price", "amount"], 1500), False)

    # Currencies.
    for slug, value, why in [
        ("eurc", "EURC", "EURC (not one of USDC, USDT, XDAI)"),
        ("usdc-lowercase", "usdc", "usdc in lower case"),
        ("xdai-mixed-case", "xDAI", "xDAI (the symbol is XDAI)"),
        ("usdc-space", "USDC ", "USDC with a trailing space"),
        ("dai-token", "DAIX", "an unknown four-letter symbol"),
        ("lowercase", "eur", "in lower case"),
        ("four-letters", "EURO", "four letters"),
        ("two-letters", "EU", "two letters"),
        ("trailing-space", "EUR ", "a trailing space"),
        ("fullwidth", "\uff25\uff35\uff32", "full-width EUR"),
        ("symbol", "\u20ac", "the euro sign"),
        ("digits", "978", "the ISO 4217 numeric code"),
        ("empty", "", "an empty string"),
    ]:
        terms_case(f"reject-currency-{slug}", f"{S_CUR}: price.currency {why}", with_path(base, ["price", "currency"], value), False)

    # Parties, payer and by.
    terms_case("reject-payer-not-party", f"{S_CANON}: price.payer is not one of the parties", with_path(base, ["price", "payer"], C), False)
    terms_case("reject-by-not-party", f"{S_CANON}: deliverables[].by is not one of the parties", with_path(base, ["deliverables", 0, "by"], C), False)
    terms_case("reject-duplicate-deliverable-id", f"{S_CANON}: two deliverables with id d1", with_path(base, ["deliverables", 1, "id"], "d1"), False)
    terms_case("reject-payer-uppercase", f"{S_ENC}: price.payer in upper-case hex", with_path(base, ["price", "payer"], "0x" + A[2:].upper()), False)
    terms_case("reject-payer-checksummed", f"{S_ENC}: price.payer EIP-55 checksummed", with_path(base, ["price", "payer"], v.eip55(A)), False)
    terms_case("reject-by-checksummed", f"{S_ENC}: deliverables[].by EIP-55 checksummed", with_path(base, ["deliverables", 0, "by"], v.eip55(B)), False)
    if v.eip55(A) == A or v.eip55(B) == B:
        v.fail("a fixture address has no upper-case letter in its checksum form")
    lo, hi = AB
    for slug, parties, why in [
        ("descending", [hi, lo], "the two parties in descending byte order"),
        ("uppercase", [lo, "0x" + hi[2:].upper()], "a party in upper-case hex"),
        ("checksummed", [v.eip55(lo), hi], "a party EIP-55 checksummed"),
        ("no-prefix", [lo, hi[2:]], "a party without 0x"),
        ("capital-0x", [lo, "0X" + hi[2:]], "a party with 0X"),
        ("short", [lo, hi[:-2]], "a party of 19 bytes"),
        ("three", sorted([A, B, C]), "three parties (two in beta)"),
        ("one", [A], "one party"),
    ]:
        terms_case(f"reject-parties-{slug}", f"{S_PARTIES}, {S_ENC}: {why}", with_path(base, ["parties"], parties), False)
    same = with_path(with_path(base, ["parties"], [A, A]), ["deliverables", 0, "by"], A)
    terms_case("reject-parties-same-twice", f"{S_PARTIES}: the same agent twice (every by and payer is that agent, so only distinctness refuses it)", same, False)

    # Dates and references.
    for slug, value, why in [
        ("offset-zero", "2026-11-30T17:00:00+00:00", "+00:00 instead of Z"),
        ("offset", "2026-11-30T18:00:00+01:00", "an offset instead of Z"),
        ("minus-zero-offset", "2026-11-30T17:00:00-00:00", "-00:00 instead of Z"),
        ("lowercase-z", "2026-11-30T17:00:00z", "a lower-case z"),
        ("lowercase-t", "2026-11-30t17:00:00Z", "a lower-case t"),
        ("space-separator", "2026-11-30 17:00:00Z", "a space instead of T"),
        ("fraction", "2026-11-30T17:00:00.000Z", "fractional seconds"),
        ("no-seconds", "2026-11-30T17:00Z", "no seconds"),
        ("date-only", "2026-11-30", "a date only"),
        ("no-zone", "2026-11-30T17:00:00", "no time zone"),
        ("feb-30", "2026-02-30T00:00:00Z", "30 February"),
        ("feb-29-common-year", "2026-02-29T00:00:00Z", "29 February in a common year"),
        ("month-13", "2026-13-01T00:00:00Z", "month 13"),
        ("hour-24", "2026-11-30T24:00:00Z", "hour 24"),
        ("leap-second", "2016-12-31T23:59:60Z", "a leap second"),
        ("short-year", "26-11-30T17:00:00Z", "a two-digit year"),
        ("unpadded", "2026-11-3T17:00:00Z", "an unpadded day"),
        ("empty", "", "an empty string"),
    ]:
        terms_case(f"reject-due-{slug}", f"{S_DATES}, {S_CANON}: deadlines[].due {why}", with_path(base, ["deadlines", 0, "due"], value), False)
    terms_case("reject-due-integer", f"{S_CANON}: deadlines[].due as unix seconds", with_path(base, ["deadlines", 0, "due"], 1796058000), False)
    terms_case("reject-deadline-unknown-ref", f"{S_REFS}: a deadline ref that names no deliverable", with_path(base, ["deadlines", 0, "ref"], "d9"), False)
    terms_case("reject-deadline-duplicate-ref", f"{S_REFS}: two deadlines for d1", with_path(base, ["deadlines"], [{"ref": "d1", "due": "2026-11-30T17:00:00Z"}, {"ref": "d1", "due": "2026-12-01T17:00:00Z"}]), False)
    terms_case("reject-deadline-empty-ref", f"{S_REFS}, {S_SIZE}: an empty deadline ref", with_path(base, ["deadlines", 0, "ref"], ""), False)

    # Version and pointer.
    terms_case("reject-version-1-with-pointer", f"{S_VER}: version 1 with a previousTermsHash", with_path(base, ["previousTermsHash"], DIGEST2), False)
    terms_case("reject-version-2-without-pointer", f"{S_VER}: version 2 with previousTermsHash null", with_path(base, ["version"], 2), False)

    # Hex, base64url and integers.
    for slug, path, value, why in [
        ("plaintext-sha256-uppercase", ["deliverables", 1, "plaintextSha256"], DIGEST.upper(), "plaintextSha256 in upper-case hex"),
        ("plaintext-sha256-0x", ["deliverables", 1, "plaintextSha256"], "0x" + DIGEST, "plaintextSha256 with 0x"),
        ("plaintext-sha256-short", ["deliverables", 1, "plaintextSha256"], DIGEST[:-2], "plaintextSha256 of 31 bytes"),
        ("plaintext-sha256-base64url", ["deliverables", 1, "plaintextSha256"], v.b64u(bytes.fromhex(DIGEST)), "plaintextSha256 as base64url"),
        ("plaintext-sha256-empty", ["deliverables", 1, "plaintextSha256"], "", "plaintextSha256 empty"),
        ("terms-id-padded", ["termsId"], TID + "==", "termsId with padding"),
        ("terms-id-15-bytes", ["termsId"], v.b64u(v.det("terms/terms-id/short", 15)), "termsId of 15 bytes"),
        ("terms-id-17-bytes", ["termsId"], v.b64u(v.det("terms/terms-id/long", 17)), "termsId of 17 bytes"),
        ("terms-id-hex", ["termsId"], v.hx(v.det("terms/terms-id/1", 16)), "termsId as hex"),
        ("terms-id-standard-alphabet", ["termsId"], "+/" + TID[2:], "termsId with + and /"),
        ("terms-id-trailing-bits", ["termsId"], TID[:-1] + B64_ALPHABET[B64_ALPHABET.index(TID[-1]) + 1], "termsId with non-zero trailing bits"),
        ("terms-id-empty", ["termsId"], "", "termsId empty"),
        ("version-zero", ["version"], 0, "version 0"),
        ("version-string", ["version"], "1", "version as a string"),
        ("version-negative", ["version"], -1, "version -1"),
        ("valid-until-string", ["validUntil"], str(VALID_UNTIL), "validUntil as a string"),
        ("valid-until-negative", ["validUntil"], -1, "validUntil -1"),
        ("valid-until-2-53", ["validUntil"], 2**53, "validUntil 2^53"),
        ("valid-until-iso", ["validUntil"], VALID_UNTIL_TEXT, "validUntil as an ISO date (unix seconds in terms)"),
    ]:
        terms_case(f"reject-{slug}", f"{S_ENC}, {S_SIZE}: {why}", with_path(base, path, value), False)
    terms_case("reject-version-2-53", f"{S_ENC}, {S_SIZE}: version 2^53 (with a pointer)", base_terms(version=2**53, previousTermsHash=DIGEST2), False)
    terms_case("reject-previous-uppercase", f"{S_ENC}: previousTermsHash in upper-case hex", base_terms(version=2, previousTermsHash=DIGEST2.upper()), False)
    terms_case("reject-previous-0x", f"{S_ENC}: previousTermsHash with 0x", base_terms(version=2, previousTermsHash="0x" + DIGEST2), False)
    terms_case("reject-previous-long", f"{S_ENC}: previousTermsHash of 33 bytes", base_terms(version=2, previousTermsHash=DIGEST2 + "00"), False)

    # Structure: unknown and missing keys, nulls.
    terms_case("reject-unknown-key", f"{S_KEYS}: an unknown top-level key", with_path(base, ["note"], "x"), False)
    terms_case("reject-terms-hash-inside", f"{S_KEYS}: termsHash inside terms", with_path(base, ["termsHash"], base_hash), False)
    terms_case("reject-unknown-deliverable-key", f"{S_KEYS}: an unknown key in a deliverable", with_path(base, ["deliverables", 0, "price"], "1"), False)
    terms_case("reject-unknown-price-key", f"{S_KEYS}: an unknown key in price", with_path(base, ["price", "usd"], "1"), False)
    terms_case("reject-unknown-deadline-key", f"{S_KEYS}: an unknown key in a deadline", with_path(base, ["deadlines", 0, "tz"], "UTC"), False)
    for key in sorted(TERMS_KEYS):
        slug = re.sub(r"([a-z])([A-Z])", r"\1-\2", key).lower()
        terms_case(f"reject-missing-{slug}", f"{S_KEYS}: {key} missing (every key is always present)", with_path(base, [key], None, delete=True), False)
    for slug, path, why in [
        ("plaintext-sha256", ["deliverables", 0, "plaintextSha256"], "a deliverable without plaintextSha256"),
        ("payer", ["price", "payer"], "price without payer"),
        ("by", ["deliverables", 0, "by"], "a deliverable without by"),
        ("id", ["deliverables", 0, "id"], "a deliverable without id"),
        ("due", ["deadlines", 0, "due"], "a deadline without due"),
    ]:
        terms_case(f"reject-missing-{slug}", f"{S_KEYS}: {why}", with_path(base, path, None, delete=True), False)
    for slug, path, why in [
        ("deadlines", ["deadlines"], "deadlines null (it is [] when there are none)"),
        ("subject", ["subject"], "subject null"),
        ("terms-id", ["termsId"], "termsId null"),
        ("valid-until", ["validUntil"], "validUntil null"),
        ("deliverable-id", ["deliverables", 0, "id"], "a deliverable id null"),
        ("description", ["deliverables", 0, "description"], "a description null"),
        ("amount", ["price", "amount"], "price.amount null"),
        ("ref", ["deadlines", 0, "ref"], "a deadline ref null"),
    ]:
        terms_case(f"reject-null-{slug}", f"{S_KEYS}: {why} (null only for price, plaintextSha256, previousTermsHash and note)", with_path(base, path, None), False)
    terms_case("reject-subject-number", f"{S_TERMS}: subject as a number", with_path(base, ["subject"], 3), False)
    terms_case("reject-price-empty-object", f"{S_KEYS}: price {{}}", with_path(base, ["price"], {}), False)
    terms_case("reject-terms-array", f"{S_TERMS}: terms as an array", [base], False)

    # 4. Raw JSON text: key order and whitespace do not change the hash; integer tokens and duplicates.
    def json_case(case_id, source, text, accept, expect_hash=None):
        try:
            parsed = strict_json(text)
            ok = accepts(parse_terms, parsed)
        except ValueError:
            ok = False
        if ok != accept:
            v.fail(f"{case_id}: the reference {'accepts' if ok else 'rejects'} it")
        if accept and terms_hash(parsed) != expect_hash:
            v.fail(f"{case_id}: hash differs from the expected one")
        expected = {"outcome": "accept", "termsHash": expect_hash} if accept else {"outcome": "reject"}
        add(f"json-{case_id}", source, {"op": "parseTermsJson", "json": text}, expected)

    def reorder(x):
        if isinstance(x, dict):
            return {k: reorder(x[k]) for k in reversed(list(x))}
        if isinstance(x, list):
            return [reorder(i) for i in x]
        return x

    compact = json.dumps(base, separators=(",", ":"), ensure_ascii=False)
    json_case("accept-compact", f"{S_HASH}: compact text in the generator's key order", compact, True, base_hash)
    json_case("accept-jcs", f"{S_HASH}: the JCS text itself", jcs(base).decode("utf-8"), True, base_hash)
    json_case("accept-reversed-key-order", f"{S_HASH}: every object's keys in reverse order; the hash is unchanged", json.dumps(reorder(base), separators=(",", ":"), ensure_ascii=False), True, base_hash)
    json_case("accept-pretty", f"{S_HASH}: indented with tabs and CRLF line ends; the hash is unchanged", json.dumps(reorder(base), indent="\t", ensure_ascii=False).replace("\n", "\r\n  "), True, base_hash)
    json_case("accept-escaped", f"{S_HASH}: \\u escapes for non-ASCII and for ASCII letters; the hash is unchanged", json.dumps(base, indent=1, ensure_ascii=True).replace('"EUR"', '"\\u0045UR"').replace('"d1"', '"\\u00641"'), True, base_hash)
    for case_id, why, old, new in [
        ("version-fraction", "version spelled 1.0", '"version":1,', '"version":1.0,'),
        ("version-exponent", "version spelled 1e0", '"version":1,', '"version":1e0,'),
        ("version-minus-zero", "version spelled -0", '"version":1,', '"version":-0,'),
        ("valid-until-fraction", f"validUntil spelled {VALID_UNTIL}.0", f'"validUntil":{VALID_UNTIL}', f'"validUntil":{VALID_UNTIL}.0'),
        ("valid-until-exponent", "validUntil with an exponent", f'"validUntil":{VALID_UNTIL}', f'"validUntil":{VALID_UNTIL // 100}e2'),
        ("valid-until-above-2-53", "validUntil 9007199254740991.4", f'"validUntil":{VALID_UNTIL}', '"validUntil":9007199254740991.4'),
        ("duplicate-subject", "a duplicate subject key (the second one differs)", '"subject":', '"subject":"other","subject":'),
        ("duplicate-amount", "a duplicate amount key inside price", '"amount":"1500.00"', '"amount":"1.00","amount":"1500.00"'),
        ("nan-valid-until", "validUntil NaN", f'"validUntil":{VALID_UNTIL}', '"validUntil":NaN'),
    ]:
        if old not in compact:
            v.fail(f"json {case_id}: substitution")
        json_case(f"reject-{case_id}", f"{S_ENC} integer tokens and I-JSON: {why}", compact.replace(old, new, 1), False)

    # 5. Bodies of offer / accept / reject (termsHash quoted and recomputed; note rules).
    def body_case(case_id, source, type_, body, accept):
        ok = accepts(parse_body, type_, body)
        if ok != accept:
            v.fail(f"body {case_id}: the reference {'accepts' if ok else 'rejects'} it")
        expected = {"outcome": "accept", "termsHash": body["termsHash"]} if accept else {"outcome": "reject"}
        add(f"body-{case_id}", source, {"op": "parseTermsBody", "type": type_, "body": body}, expected)

    b = body_of(base)
    note500 = astral * 10 + "n" * 490
    body_case("accept-offer", f"{S_BODY}: an offer, note null", "offer", b, True)
    body_case("accept-offer-note", f"{S_BODY}: an offer with a note; the note is not covered by termsHash", "offer", body_of(base, "Happy to discuss the deadline."), True)
    body_case("accept-reject-note", f"{S_BODY}: a reject with a note", "reject", body_of(base, "Too expensive."), True)
    body_case("accept-accept", f"{S_BODY}: an accept, note null", "accept", b, True)
    body_case("accept-note-500", f"{S_SIZE}: a note of 500 code points (510 UTF-16 units)", "reject", body_of(base, note500), True)
    body_case("reject-note-501", f"{S_SIZE}: a note of 501 code points", "reject", body_of(base, note500 + "n"), False)
    body_case("reject-note-empty", f"{S_SIZE}: an empty note (null or 1 to 500 code points)", "reject", body_of(base, ""), False)
    body_case("reject-note-rlo", f"{S_CHARS}: U+202E in a note", "reject", body_of(base, "Too \u202eexpensive"), False)
    body_case("reject-note-line-separator", f"{S_CHARS}: U+2028 in a note", "offer", body_of(base, "a\u2028b"), False)
    body_case("reject-note-newline", f"{S_CHARS}: a line feed in a note", "offer", body_of(base, "a\nb"), False)
    body_case("reject-accept-note", f"{S_BODY}: a note on an accept", "accept", body_of(base, "Agreed."), False)
    body_case("reject-hash-mismatch", f"{S_BODY}: termsHash of other terms (the core recomputes it)", "offer", {**b, "termsHash": terms_hash(v2)}, False)
    body_case("reject-hash-of-pretty-text", f"{S_BODY}: termsHash over indented text, not JCS", "offer", {**b, "termsHash": v.hx(v.sha256(json.dumps(base, indent=2).encode()))}, False)
    body_case("reject-hash-uppercase", f"{S_BODY}, {S_ENC}: termsHash in upper-case hex", "offer", {**b, "termsHash": base_hash.upper()}, False)
    body_case("reject-hash-0x", f"{S_BODY}, {S_ENC}: termsHash with 0x", "offer", {**b, "termsHash": "0x" + base_hash}, False)
    body_case("reject-hash-missing", f"{S_KEYS}: termsHash missing", "offer", {"terms": base, "note": None}, False)
    body_case("reject-note-missing", f"{S_KEYS}: note missing (null when there is none)", "offer", {"terms": base, "termsHash": base_hash}, False)
    body_case("reject-unknown-key", f"{S_KEYS}: an unknown body key", "offer", {**b, "extra": 1}, False)
    body_case("reject-terms-invalid", f"{S_BODY}, {S_CHARS}: terms with an RLO in subject, whatever the quoted hash", "offer", body_of(with_path(base, ["subject"], "a\u202eb")), False)
    body_case("reject-note-number", f"{S_BODY}: note as a number", "reject", body_of(base, 7), False)

    # 6. TermsInput (06 §2.2a, D-74): the agent supplies only these fields.
    ti = {
        "subject": "Spec v2 \u2013 milestone 3",
        "deliverables": [
            {"id": "d1", "description": "Milestone 3 report", "by": "them"},
            {"id": "d2", "description": "Review of the report", "by": "me", "plaintextSha256": DIGEST},
        ],
        "price": {"amount": "1500.00", "currency": "EUR", "payer": "me"},
        "deadlines": [{"ref": "d1", "due": "2026-11-30T17:00:00Z"}],
        "validUntil": VALID_UNTIL_TEXT,
    }
    if check_due(VALID_UNTIL_TEXT) != VALID_UNTIL:
        v.fail("validUntil fixture")

    def input_case(case_id, source, termsinput, accept, now=NOW):
        ok = accepts(parse_input, termsinput, now)
        if ok != accept:
            v.fail(f"input {case_id}: the reference {'accepts' if ok else 'rejects'} it")
        add(f"input-{case_id}", source, {"op": "parseTermsInput", "termsInput": termsinput, "now": now}, {"outcome": "accept" if accept else "reject"})

    input_case("accept-full", f"{S_INPUT}: every field", ti, True)
    input_case("accept-minimal", f"{S_INPUT}: subject and one deliverable, no id", {"subject": "x", "deliverables": [{"description": "y", "by": "me"}]}, True)
    input_case("accept-valid-until-now-plus-1", f"{S_INPUT}: validUntil one second after now", ti, True, now=VALID_UNTIL - 1)
    input_case("reject-valid-until-now", f"{S_INPUT}: validUntil equal to now (it must be after now)", ti, False, now=VALID_UNTIL)
    input_case("reject-valid-until-past", f"{S_INPUT}: validUntil before now", ti, False, now=VALID_UNTIL + 86400)
    for key, value in [
        ("termsId", TID),
        ("version", 1),
        ("parties", AB),
        ("previousTermsHash", None),
        ("termsHash", base_hash),
        ("note", "x"),
        ("foo", 1),
    ]:
        slug = re.sub(r"([a-z])([A-Z])", r"\1-\2", key).lower()
        input_case(f"reject-{slug}", f"{S_INPUT}, M1-21: TermsInput refuses `{key}` (core-filled, or an unknown key)", {**ti, key: value}, False)
    no_ids = {"subject": "x", "deliverables": [{"description": "a", "by": "me"}, {"description": "b", "by": "them"}]}
    for slug, termsinput, why in [
        ("price-null", with_path(ti, ["price"], None), "price null (leave it out instead)"),
        ("deadlines-null", with_path(ti, ["deadlines"], None), "deadlines null"),
        ("valid-until-null", with_path(ti, ["validUntil"], None), "validUntil null"),
        ("plaintext-sha256-null", with_path(ti, ["deliverables", 0, "plaintextSha256"], None), "plaintextSha256 null"),
        ("id-null", with_path(ti, ["deliverables", 0, "id"], None), "a deliverable id null"),
        ("mixed-ids", with_path(no_ids, ["deliverables", 0, "id"], "d1"), "ids on some deliverables only"),
        ("mixed-ids-no-collision", with_path(no_ids, ["deliverables", 1, "id"], "x9"), "ids on some deliverables only, even without a collision"),
        ("rlo-subject", with_path(ti, ["subject"], "Spec \u202ev2"), "an RLO in subject"),
        ("zwsp-description", with_path(ti, ["deliverables", 0, "description"], "Mile\u200bstone"), "a zero-width space in a deliverable"),
        ("line-separator", with_path(ti, ["subject"], "a\u2028b"), "U+2028 in subject"),
        ("unassigned", with_path(ti, ["subject"], "x\u0378"), "an unassigned code point"),
        ("cyrillic-currency", with_path(ti, ["price", "currency"], "\u0415UR"), "Cyrillic \u0415UR"),
        ("currency-eurc", with_path(ti, ["price", "currency"], "EURC"), "EURC"),
        ("amount-7-decimals", with_path(ti, ["price", "amount"], "1500.0000001"), "1500.0000001"),
        ("amount-zero", with_path(ti, ["price", "amount"], "0"), "amount 0"),
        ("due-offset", with_path(ti, ["deadlines", 0, "due"], "2026-11-30T18:00:00+01:00"), "a due date with an offset"),
        ("valid-until-offset", with_path(ti, ["validUntil"], "2026-09-28T16:13:20+02:00"), "validUntil with an offset"),
        ("valid-until-fraction", with_path(ti, ["validUntil"], "2026-09-28T14:13:20.000Z"), "validUntil with a fraction"),
        ("valid-until-date-only", with_path(ti, ["validUntil"], "2026-09-28"), "validUntil as a date only"),
        ("valid-until-integer", with_path(ti, ["validUntil"], VALID_UNTIL), "validUntil as unix seconds (TermsInput takes a string)"),
        ("plaintext-sha256-uppercase", with_path(ti, ["deliverables", 1, "plaintextSha256"], DIGEST.upper()), "upper-case hex"),
        ("by-address", with_path(ti, ["deliverables", 0, "by"], B), "by as an agent ID (only me | them)"),
        ("by-other", with_path(ti, ["deliverables", 0, "by"], "us"), "by outside me | them"),
        ("payer-address", with_path(ti, ["price", "payer"], A), "payer as an agent ID (only me | them)"),
        ("payer-capitalised", with_path(ti, ["price", "payer"], "Me"), "payer \"Me\""),
        ("deliverables-empty", with_path(ti, ["deliverables"], []), "no deliverables (at least one)"),
        ("unknown-deliverable-key", with_path(ti, ["deliverables", 0, "deadline"], "x"), "an unknown deliverable key"),
        ("unknown-price-key", with_path(ti, ["price", "usd"], "1"), "an unknown price key"),
        ("duplicate-id", with_path(ti, ["deliverables", 1, "id"], "d1"), "duplicate deliverable ids"),
        ("unknown-ref", with_path(ti, ["deadlines", 0, "ref"], "d9"), "a deadline ref that names no deliverable"),
        ("duplicate-ref", with_path(ti, ["deadlines"], [{"ref": "d1", "due": "2026-11-30T17:00:00Z"}, {"ref": "d1", "due": "2026-12-30T17:00:00Z"}]), "two deadlines for d1"),
        ("subject-empty", with_path(ti, ["subject"], ""), "an empty subject"),
        ("subject-201", with_path(ti, ["subject"], "s" * 201), "a subject of 201 code points"),
        ("id-17", with_path(with_path(ti, ["deliverables", 0, "id"], "a" * 17), ["deadlines", 0, "ref"], "a" * 17), "a deliverable id of 17 characters"),
        ("subject-missing", with_path(ti, ["subject"], None, delete=True), "no subject"),
    ]:
        input_case(f"reject-{slug}", f"{S_INPUT}: {why}", termsinput, False)

    # Mapping to terms.
    def map_case(case_id, source, termsinput, ctx):
        terms = map_input(termsinput, ctx)
        add(
            f"map-{case_id}",
            source,
            {"op": "mapTermsInput", "termsInput": termsinput, "context": ctx},
            {"termsHash": terms_hash(terms), "termsJcs": jcs(terms).decode("utf-8")},
        )
        return terms

    ctx_a = {"me": A, "them": B, "termsId": TID, "version": 1, "previousTermsHash": None, "now": NOW}
    mapped = map_case("full", f"{S_INPUT}: me/them mapped to agent IDs in by and payer, parties in ascending byte order, validUntil to unix seconds, core-filled fields from the context", ti, ctx_a)
    if mapped != base:
        v.fail("the full TermsInput must map to the base terms")
    map_case(
        "defaults",
        f"{S_INPUT}: absent price maps to null, deadlines to [], plaintextSha256 to null; ids default to d1, d2; validUntil = now + 604800",
        {"subject": "Logo files", "deliverables": [{"description": "SVG logo", "by": "them"}, {"description": "PNG exports", "by": "them"}]},
        ctx_a,
    )
    map_case(
        "counter-by-b",
        f"{S_INPUT}: B's core counters version 1 with version 2; me = B; parties keep ascending byte order",
        with_path(ti, ["price", "amount"], "1400.00"),
        {"me": B, "them": A, "termsId": TID, "version": 2, "previousTermsHash": base_hash, "now": NOW},
    )

    # 7. The runtime probe.
    probe = "x\u0301\U00010efd"
    nfc = unicodedata.normalize("NFC", probe)
    if nfc != "x\U00010efd\u0301":
        v.fail("this Python does not reorder U+10EFD (Unicode 15.0 or later needed)")
    add("unicode-probe", f"{S_PROBE}: \"x\\u0301\\u{{10EFD}}\".normalize(\"NFC\") on a Unicode 15.0+ runtime", {"op": "unicodeProbe", "probe": probe}, {"nfc": nfc})

    # 8. The negotiation chain. Envelopes between A and B, seen from one core.
    def chain_case(case_id, source, me, log, incoming, outcome, now=NOW):
        got, version, h = chain_receive(me, log, incoming)
        if got != outcome:
            v.fail(f"chain {case_id}: the reference model says {got}")
        add(
            f"chain-{case_id}",
            source,
            {"op": "chainReceive", "self": me, "now": now, "log": log, "incoming": incoming},
            {"outcome": outcome, "newestVersion": str(version), "newestTermsHash": h or "null"},
        )

    def offer(label, sender, version, prev, tid=TID, other=None, reply_to=None, **over):
        to = other or (B if sender == A else A)
        parties = sorted([sender, to])
        t = base_terms(termsId=tid, version=version, previousTermsHash=prev, parties=parties, **over)
        t["deliverables"] = [dict(d, by=parties[i % 2]) for i, d in enumerate(t["deliverables"])]
        t["price"] = dict(t["price"], payer=parties[0])
        return env(label, sender, to, "offer", t, reply_to=reply_to)

    def h_of(e):
        return e["body"]["termsHash"]

    def answer(label, sender, type_, offer_env, terms=None, note=None, reply_to=None, created_at=NOW):
        t = terms if terms is not None else offer_env["body"]["terms"]
        to = offer_env["from"] if offer_env["from"] != sender else offer_env["to"]
        return env(label, sender, to, type_, t, reply_to=reply_to or offer_env["id"], note=note, created_at=created_at)

    a1 = offer("a1", A, 1, None)
    b2 = offer("b2", B, 2, h_of(a1), subject="Spec v2 \u2013 milestone 3 (counter)")
    a3 = offer("a3", A, 3, h_of(b2), subject="Spec v2 \u2013 milestone 3 (final)")
    b3gap = offer("b3gap", B, 3, h_of(a1))

    chain_case("new-negotiation", f"{S_CHAIN}: a first offer, version 1 with previousTermsHash null", B, [], a1, "valid")
    chain_case("counter", f"{S_CHAIN}: version = newest + 1 and previousTermsHash = newest hash", A, [sent(a1)], b2, "valid")
    chain_case("third-version", f"{S_CHAIN}: version 3 on version 2", B, [received(a1), sent(b2)], a3, "valid")
    chain_case("new-not-version-1", f"{S_CHAIN}: a new negotiation that starts at version 2 with a pointer", B, [], offer("x2", A, 2, DIGEST2), "refused")
    chain_case("version-gap", f"{S_CHAIN}: a version gap (version 3 on newest 1)", A, [sent(a1)], b3gap, "refused")
    chain_case("pointer-to-older", f"{S_CHAIN}: version 3 whose previousTermsHash names version 1, not the newest (2)", B, [received(a1), sent(b2)], offer("a3old", A, 3, h_of(a1)), "refused")
    chain_case("pointer-unknown", f"{S_CHAIN}: version 2 whose previousTermsHash names no stored version", A, [sent(a1)], offer("b2x", B, 2, DIGEST2), "refused")

    # The same termsId from another pair (A-C at version 3) does not affect A-B.
    c1 = offer("c1", C, 1, None, other=A)
    a2c = offer("a2c", A, 2, h_of(c1), other=C)
    c3 = offer("c3", C, 3, h_of(a2c), other=A)
    log_ac = [received(c1), sent(a2c), received(c3)]
    chain_case("same-terms-id-other-pair", f"{S_CHAIN}: the same termsId from another pair (A-C, version 3) does not affect A-B; B's version 1 is valid", A, log_ac, offer("b1", B, 1, None), "valid")
    chain_case("same-terms-id-other-pair-continued", f"{S_CHAIN}: B cannot continue the A-C chain: version 4 on A-C's version 3 is refused for A-B", A, log_ac, offer("b4", B, 4, h_of(c3)), "refused")
    bac = offer("bac", A, 1, None, other=C)
    bac = dict(bac, **{"from": B, "to": A})
    chain_case("not-a-party", f"{S_CHAIN}, 04 §3.4: an offer from B whose parties are A and C", A, [], bac, "refused")

    # Duplicates and rule 1 (by envelopeHash).
    b2_again = env("b2-again", B, A, "offer", b2["body"]["terms"])
    chain_case("duplicate", f"{S_DUP}: the same envelope again (same envelopeHash) is dropped before the chain rules", A, [sent(a1), received(b2)], copy.deepcopy(b2), "duplicate")
    chain_case("same-sender-same-terms", f"{S_CHAIN} rule 1: the same terms re-sent in a new envelope; the first one seen wins", A, [sent(a1), received(b2)], b2_again, "refused")
    chain_case("same-sender-other-terms", f"{S_CHAIN} rule 1: a second version 2 from B with other terms", A, [sent(a1), received(b2)], offer("b2-other", B, 2, h_of(a1), subject="other"), "refused")
    same_id = dict(offer("b2-same-id", B, 2, h_of(a1), subject="same id, other content"), id=b2["id"])
    chain_case("same-sender-same-id-other-content", f"{S_DUP}, {S_CHAIN} rule 1: the same envelope id with other content is a different envelope (compared by envelopeHash), refused under rule 1", A, [sent(a1), received(b2)], same_id, "refused")
    chain_case("same-sender-first-refused-replay", f"{S_CHAIN} rule 1: a third version-2 envelope after a refused second one; still the first wins", A, [sent(a1), received(b2), received(b2_again)], offer("b2-third", B, 2, h_of(a1), subject="third"), "refused")

    # Rule 2: a version is locked once an accept for it was sent or received.
    acc_b2 = answer("acc-b2", A, "accept", b2)
    chain_case("fork-after-accept-sent", f"{S_CHAIN} rule 2: A accepted B's version 2; B's other version-2 envelope is refused", A, [sent(a1), received(b2), sent(acc_b2)], offer("b2-fork", B, 2, h_of(a1), subject="fork"), "refused")
    a2 = offer("a2", A, 2, h_of(a1), subject="Spec v2 \u2013 milestone 3 (revised)")
    acc_a2 = answer("acc-a2", B, "accept", a2)
    log_acc = [sent(a1), sent(a2), received(acc_a2)]
    chain_case("fork-after-accept-received", f"{S_CHAIN} rule 2: B accepted A's version 2; a version-2 counter from B is refused, not a conflict, and version 2 stays newest", A, log_acc, offer("b2-late", B, 2, h_of(a1), subject="late counter"), "refused")
    chain_case("second-accept", f"{S_CHAIN} rule 2: a second accept envelope for the accepted version", A, log_acc, answer("acc-a2-again", B, "accept", a2, created_at=NOW + 1), "refused")
    chain_case("offer-after-accept", f"{S_AFTER}: version 3 on the accepted version 2 continues the negotiation", A, log_acc, offer("b3-after", B, 3, h_of(a2)), "valid")
    chain_case("resend-on-locked", f"{S_RESEND}: rule 2 takes precedence: B accepted A's version 2, so a resend for 2 naming A's envelope is refused and cannot void it", A, log_acc, offer("b2-resend-locked", B, 2, h_of(a1), reply_to=a2["id"], subject="void it"), "refused")

    # Rule 3 and the anchored resends.
    a2r = offer("a2-rev", A, 2, h_of(a1), subject="A's revision")
    b2c = offer("b2-ctr", B, 2, h_of(a1), subject="B's counter")
    b2rs = offer("b2-resend", B, 2, h_of(a1), reply_to=a2r["id"], subject="B's resend")
    a2rs = offer("a2-resend", A, 2, h_of(a1), reply_to=b2c["id"], subject="A's resend")
    log_conf_a = [sent(a1), sent(a2r), received(b2c)]
    log_conf_b = [received(a1), sent(b2c), received(a2r)]
    chain_case("concurrent-counters-a", f"{S_CHAIN} rule 3: A revised version 1 to 2 while B countered it with 2; a conflict, version 1 stays newest", A, [sent(a1), sent(a2r)], b2c, "conflict")
    chain_case("concurrent-counters-b", f"{S_CHAIN} rule 3: the same conflict seen by B; both cores detect it the same way", B, [received(a1), sent(b2c)], a2r, "conflict")
    chain_case("resend-after-original-a", f"{S_RESEND} item 2: after the conflict, B's resend naming A's conflicting envelope is valid", A, log_conf_a, b2rs, "valid")
    chain_case("resend-after-original-b", f"{S_RESEND} item 2: the same seen by B, A's resend naming B's conflicting envelope", B, log_conf_b, a2rs, "valid")
    chain_case("resend-before-original-a", f"{S_RESEND} item 1: B's resend arrives before B's original; it reveals the conflict, A's version 2 is not acceptable, the resend is B's envelope for 2", A, [sent(a1), sent(a2r)], b2rs, "valid")
    chain_case("resend-before-original-b", f"{S_RESEND} item 1: A's resend arrives at B before A's original", B, [received(a1), sent(b2c)], a2rs, "valid")
    chain_case("original-after-resend-a", f"{S_RESEND} item 1: B's original, arriving after its resend, belongs to the conflict and is refused", A, [sent(a1), sent(a2r), received(b2rs)], b2c, "refused")
    chain_case("original-after-resend-b", f"{S_RESEND} item 1: A's original, arriving at B after its resend, is refused", B, [received(a1), sent(b2c), received(a2rs)], a2r, "refused")
    chain_case("resend-without-link", f"{S_RESEND} item 2: after the conflict, an envelope for 2 without the replyTo link is refused", A, log_conf_a, offer("b2-nolink", B, 2, h_of(a1), subject="no link"), "refused")
    chain_case("second-resend", f"{S_RESEND} item 2, rule 1: a second resend from the same sender is refused", A, log_conf_a + [received(b2rs)], offer("b2-resend-2", B, 2, h_of(a1), reply_to=a2r["id"], subject="second resend"), "refused")
    chain_case("resend-unknown-reply-to", f"{S_RESEND} item 3: a resend whose replyTo names an envelope the receiver does not hold", A, log_conf_a, offer("b2-unknown", B, 2, h_of(a1), reply_to=v.b64u(v.det("terms/envelope/nowhere", 16)), subject="unknown"), "refused")
    chain_case("resend-names-other-version", f"{S_RESEND} item 3: a resend whose replyTo names the receiver's version-1 envelope, not its envelope for 2", A, log_conf_a, offer("b2-v1link", B, 2, h_of(a1), reply_to=a1["id"], subject="wrong link"), "refused")
    chain_case("resend-names-own", f"{S_RESEND} item 3: a resend whose replyTo names the sender's own conflicting envelope", A, log_conf_a, offer("b2-self", B, 2, h_of(a1), reply_to=b2c["id"], subject="self link"), "refused")
    chain_case("resend-wrong-pointer", f"{S_RESEND}: a resend for 2 must point to version 1", A, log_conf_a, offer("b2-badptr", B, 2, DIGEST2, reply_to=a2r["id"], subject="bad pointer"), "refused")
    log_two = log_conf_a + [sent(a2rs)]
    chain_case("two-resends-new-conflict", f"{S_RESEND} item 4: A resent, then B's resend arrives; two resends are a new conflict and version 1 stays newest", A, log_two, b2rs, "conflict")
    b2rs2 = offer("b2-resend-r2", B, 2, h_of(a1), reply_to=a2rs["id"], subject="B's second-round resend")
    chain_case("resend-after-second-conflict", f"{S_RESEND} item 4: after the second conflict, B's resend naming A's resend is valid", A, log_two + [received(b2rs)], b2rs2, "valid")
    chain_case("stale-link-after-second-conflict", f"{S_RESEND} items 2 and 4: after the second conflict, a resend naming A's first-round envelope is refused", A, log_two + [received(b2rs)], offer("b2-stale", B, 2, h_of(a1), reply_to=a2r["id"], subject="stale"), "refused")
    chain_case("conflicted-not-a-base", f"{S_CHAIN} rule 3: the conflicting envelopes are not acceptable, so version 3 on B's conflicted version 2 is refused", A, log_conf_a, offer("b3-on-conflict", B, 3, h_of(b2c)), "refused")

    # Answers on receipt.
    chain_case("accept-matching", f"{S_ANSWER}: B accepts A's newest version; replyTo names it and the terms are copied exactly", A, [sent(a1), sent(a2)], acc_a2, "valid")
    chain_case("accept-hash-mismatch", f"{S_ANSWER}, M1-21 Acceptance: an accept whose termsHash does not match the offer it answers (it quotes version 1's terms) is refused", A, [sent(a1), sent(a2)], answer("acc-mismatch", B, "accept", a2, terms=a1["body"]["terms"]), "refused")
    chain_case("accept-terms-changed", f"{S_ANSWER}: an accept whose terms differ from the named offer (consistent hash of other terms)", A, [sent(a1), sent(a2)], answer("acc-changed", B, "accept", a2, terms=with_path(a2["body"]["terms"], ["subject"], "changed")), "refused")
    chain_case("accept-no-reply-to", f"{S_ANSWER}: an accept with replyTo null", A, [sent(a1), sent(a2)], dict(acc_a2, replyTo=None, id=v.b64u(v.det("terms/envelope/acc-null", 16))), "refused")
    chain_case("accept-own-offer", f"{S_ANSWER}: an accept that answers B's own offer", A, [sent(a1), received(b2)], env("acc-own", B, A, "accept", b2["body"]["terms"], reply_to=b2["id"]), "refused")
    chain_case("accept-superseded-own-offer", f"{S_ANSWER}: B accepts A's version 1 after A sent version 2; stored as valid (answering it needs the owner's approval)", A, [sent(a1), sent(a2)], answer("acc-a1", B, "accept", a1), "valid")
    chain_case("accept-conflicted-offer", f"{S_CHAIN} rule 3: an accept of A's conflicting version 2 is refused", A, log_conf_a, answer("acc-a2r", B, "accept", a2r), "refused")
    chain_case("accept-created-at-valid-until", f"{S_VALID}: an accept signed at createdAt = validUntil and delivered an hour later is timely (the receiver's clock is not used)", A, [sent(a1), sent(a2)], answer("acc-at-limit", B, "accept", a2, created_at=VALID_UNTIL), "valid", now=VALID_UNTIL + 3600)
    chain_case("accept-created-at-after-valid-until", f"{S_VALID}: an accept signed at createdAt = validUntil + 1 has lapsed", A, [sent(a1), sent(a2)], answer("acc-late", B, "accept", a2, created_at=VALID_UNTIL + 1), "refused", now=VALID_UNTIL + 1)
    chain_case("reject-message", f"{S_ANSWER}, 06 §2.2a: a plain reject is stored and is not final; version 2 stays newest", A, [sent(a1), sent(a2)], answer("rej-a2", B, "reject", a2, note="Too expensive."), "valid")
    chain_case("reject-created-at-after-valid-until", f"{S_VALID}: a reject signed after validUntil has lapsed", A, [sent(a1), sent(a2)], answer("rej-late", B, "reject", a2, created_at=VALID_UNTIL + 1), "refused")
    acc_b_a1 = answer("acc-b-a1", B, "accept", a1)
    log_path_b = [received(a1), sent(acc_b_a1)]
    chain_case("reject-path-b", f"{S_ANSWER}, 06 §2.2a path (b): after B accepted A's version 1, A's reject names A's own offer and carries its terms", B, log_path_b, answer("rej-path-b", A, "reject", a1, reply_to=a1["id"]), "valid")
    chain_case("reject-path-b-names-accept", f"{S_ANSWER}: a path-(b) reject whose replyTo names B's accept, not A's own offer, is refused", B, log_path_b, env("rej-path-b-acc", A, B, "reject", a1["body"]["terms"], reply_to=acc_b_a1["id"]), "refused")
    chain_case("reject-own-offer-not-accepted", f"{S_ANSWER}: a reject naming the sender's own offer that the receiver never accepted is refused", B, [received(a1)], answer("rej-own", A, "reject", a1, reply_to=a1["id"]), "refused")

    # A sending core sets version, previousTermsHash and, for a resend, replyTo.
    def next_case(case_id, source, me, contact, tid, log, version, prev, reply_to=None):
        got = next_offer(me, contact, tid, log)
        if got != (version, prev, reply_to):
            v.fail(f"next {case_id}: the reference model says {got}")
        add(
            f"next-{case_id}",
            source,
            {"op": "nextOffer", "self": me, "contact": contact, "termsId": tid, "log": log},
            {"version": str(version), "previousTermsHash": prev or "null", "replyTo": reply_to or "null"},
        )

    next_case("new", f"{S_CHAIN}: a new negotiation is version 1 with previousTermsHash null", A, B, TID, [], 1, None)
    next_case("after-counter", f"{S_CHAIN}: newest + 1 and the newest termsHash", A, B, TID, [sent(a1), received(b2)], 3, h_of(b2))
    next_case("ignores-pointer", f"{S_CHAIN}: computed from the own store, never from a refused counterparty pointer", A, B, TID, [sent(a1), received(b3gap)], 2, h_of(a1))
    next_case("other-pair", f"{S_CHAIN}: the A-C chain of the same termsId does not count for A-B", A, B, TID, log_ac, 1, None)
    next_case("after-accept", f"{S_AFTER}: after version 2 was accepted the next offer is version 3 on version 2", A, B, TID, log_acc, 3, h_of(a2))
    next_case("after-conflict", f"{S_RESEND}: after a conflict the previous version stays newest; the resend is version 2 on version 1 and names B's conflicting envelope", A, B, TID, log_conf_a, 2, h_of(a1), b2c["id"])
    next_case("after-own-resend", f"{S_RESEND}: after A's resend for 2 is pending, A's next offer is version 3 on its resend", A, B, TID, log_conf_a + [sent(a2rs)], 3, h_of(a2rs))

    # Sending an accept (04 §3.4): the newest offer received from that contact, within validUntil.
    def accept_case(case_id, source, me, now, log, answers, allowed):
        got = send_accept(me, now, log, answers)
        if (got is not None) != allowed:
            v.fail(f"send-accept {case_id}: the reference model says {got}")
        expected = {"outcome": "allowed", "termsHash": got} if allowed else {"outcome": "refused"}
        add(f"send-accept-{case_id}", source, {"op": "sendAccept", "self": me, "now": now, "log": log, "answers": answers}, expected)

    log_b2 = [sent(a1), received(b2)]
    accept_case("newest", f"{S_ACCEPT}: B's version 2 is the newest offer received from B", A, NOW, log_b2, b2["id"], True)
    accept_case("at-valid-until", f"{S_ACCEPT}, {S_VALID}: the own clock equals validUntil (t <= validUntil)", A, VALID_UNTIL, log_b2, b2["id"], True)
    accept_case("expired", f"{S_ACCEPT}, {S_VALID}: the own clock is validUntil + 1 (TERMS_EXPIRED)", A, VALID_UNTIL + 1, log_b2, b2["id"], False)
    accept_case("superseded", f"{S_ACCEPT}: A's version 3 superseded B's version 2 (TERMS_SUPERSEDED)", A, NOW, log_b2 + [sent(a3)], b2["id"], False)
    accept_case("older-version", f"{S_ACCEPT}: B answers A's version 1 after A's version 3 arrived", B, NOW, [received(a1), sent(b2), received(a3)], a1["id"], False)
    accept_case("own-offer", f"{S_ACCEPT}: an offer A sent itself", A, NOW, log_b2, a1["id"], False)
    accept_case("refused-offer", f"{S_ACCEPT}: an offer the store refused (a version gap)", A, NOW, [sent(a1), received(b3gap)], b3gap["id"], False)
    accept_case("conflicted", f"{S_ACCEPT}, {S_CHAIN} rule 3: B's conflicting version 2 is not acceptable", A, NOW, log_conf_a, b2c["id"], False)
    accept_case("resend", f"{S_ACCEPT}, {S_RESEND}: B's valid resend for 2 is acceptable", A, NOW, log_conf_a + [received(b2rs)], b2rs["id"], True)
    accept_case("locked", f"{S_ACCEPT}, {S_CHAIN} rule 2: version 2 is already accepted", A, NOW, log_b2 + [sent(acc_b2)], b2["id"], False)
    accept_case("unknown-envelope", f"{S_ACCEPT}: no stored offer with that id", A, NOW, log_b2, v.b64u(v.det("terms/envelope/unknown", 16)), False)
    return cases


S = v.STRING
NULLABLE_HEX = {"type": "string", "pattern": "^([0-9a-f]{64}|null)$"}
SCHEMA = v.case_schema(
    SUITE,
    "04 §3.4 (D-32, D-55, D-74), 06 §2.2a: terms, termsHash, the offer/accept/reject body, TermsInput "
    "and its mapping, the Unicode 15.0 runtime probe, and the negotiation chain (see "
    "tools/vectors/generate_terms.py for the abstract envelope model).",
    {
        "parseTerms": ({"terms": v.ANY}, [{"outcome": {"const": "accept"}, "termsHash": v.hexn(32)}, v.REJECT]),
        "parseTermsJson": ({"json": S}, [{"outcome": {"const": "accept"}, "termsHash": v.hexn(32)}, v.REJECT]),
        "parseTermsBody": ({"type": S, "body": v.ANY}, [{"outcome": {"const": "accept"}, "termsHash": v.hexn(32)}, v.REJECT]),
        "parseTermsInput": ({"termsInput": v.ANY, "now": v.INTEGER}, [v.ACCEPT, v.REJECT]),
        "mapTermsInput": ({"termsInput": v.OBJECT, "context": v.OBJECT}, [{"termsHash": v.hexn(32), "termsJcs": S}]),
        "unicodeProbe": ({"probe": S}, [{"nfc": S}]),
        "chainReceive": (
            {"self": v.ADDRESS, "now": v.INTEGER, "log": v.ARRAY, "incoming": v.OBJECT},
            [{"outcome": {"enum": ["valid", "refused", "conflict", "duplicate"]}, "newestVersion": {"type": "string", "pattern": "^(0|[1-9][0-9]*)$"}, "newestTermsHash": NULLABLE_HEX}],
        ),
        "nextOffer": (
            {"self": v.ADDRESS, "contact": v.ADDRESS, "termsId": v.B64U, "log": v.ARRAY},
            [{"version": {"type": "string", "pattern": "^[1-9][0-9]*$"}, "previousTermsHash": NULLABLE_HEX, "replyTo": {"type": "string", "pattern": "^([A-Za-z0-9_-]{22}|null)$"}}],
        ),
        "sendAccept": (
            {"self": v.ADDRESS, "now": v.INTEGER, "log": v.ARRAY, "answers": v.B64U},
            [{"outcome": {"const": "allowed"}, "termsHash": v.hexn(32)}, {"outcome": {"const": "refused"}}],
        ),
    },
)

if __name__ == "__main__":
    v.main(
        suite=SUITE,
        version=VERSION,
        script="tools/vectors/generate_terms.py",
        libraries=["coincurve", "pycryptodome", "rfc8785"],
        build=build,
        schema=SCHEMA,
        doc=__doc__,
    )
