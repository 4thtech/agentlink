#!/usr/bin/env python3
"""Independent generator for the `terms` suite: `terms`, `termsHash`, `TermsInput` and the negotiation chain (M1-21).

Written from the spec only (04 §2.4.1, §3.1, §3.4; 06 §2.2a; D-32, D-55), by a session that does not
implement the TypeScript schema, under the M1-1h rules. Nothing here reads `@agentlink/types`.

What the spec fixes (04 §3.4):
  terms       {termsId, version, parties, subject, deliverables[{id, description, by, plaintextSha256}],
               price?{amount, currency, payer}, deadlines[{ref, due}], validUntil, previousTermsHash}
  termsHash = sha256(JCS(terms)), RFC 8785, 64 lowercase hex, no prefix (04 §2.4.1).
  Encodings (04 §2.4.1): `termsId` base64url of 16 bytes; `parties[]`, `by`, `payer` 0x + 40 lowercase
  hex; `plaintextSha256`, `previousTermsHash`, `termsHash` 64 lowercase hex; integers are JSON integer
  tokens `0|[1-9][0-9]*` in [0, 2^53 - 1].
  Canonical form (D-55): every string NFC, no C0/C1 control, no bidi control, no other Cf, no private
  use; amount `^(0|[1-9][0-9]*)(\\.[0-9]{1,6})?$` and > 0; currency `^[A-Z]{3}$` or an allowlisted
  token symbol; payer and every `by` in `parties`; unique deliverable ids; `due` exactly
  `YYYY-MM-DDTHH:MM:SSZ`. Refused, never rewritten.
  Chain (D-55): key = termsId + unordered pair of parties; a received offer is valid only when
  version = newest + 1 and previousTermsHash = newest hash; no forks (rules 1-4).

The reference parser and the reference chain model below are this generator's own reading of the
spec (Python `re`, `unicodedata`, `calendar`). Every case's declared outcome is checked against them,
so a case that the reference disagrees with stops the generator. Hashes come from `rfc8785` and are
cross-checked against a second JCS serialisation written out here (sorted ASCII keys, no whitespace,
which equals RFC 8785 for these shapes: no floats, ASCII keys).

Ops (the harness module maps each to the code under test):
  parseTerms       {terms}                          -> accept + termsHash | reject
  parseTermsJson   {json}  (raw JSON text)          -> accept + termsHash | reject
  parseTermsBody   {type, body} (offer/accept/reject body) -> accept + termsHash | reject
  parseTermsInput  {termsInput}                     -> accept | reject
  mapTermsInput    {termsInput, context}            -> termsHash + termsJcs (the mapped terms)
  chainReceive     {self, now, log, incoming}       -> valid | refused | conflict, plus the newest
                                                       version and termsHash of the incoming's key
  nextOffer        {self, contact, termsId, log}    -> version + previousTermsHash a sending core sets
  sendAccept       {self, now, log, answers}        -> allowed + termsHash | refused
Chain cases model envelopes abstractly: `{id, from, to, type, replyTo, body}` with `from` and `to`
as agent IDs (the core maps the envelope's Nostr `from` to the contact's agent ID). `log` is the
ordered history of envelopes the core has sent and received for this pair; the core replays it to
build its state (refused and conflicting envelopes stay in the log, as the core stores them).
`now` is unix seconds. "null" in an expected field means JSON null; "0" as newestVersion means no
valid offer exists for that key.

OPEN QUESTIONS. Where the spec is ambiguous, the case's `source` starts with `OPEN QUESTION Qn` and
states the reading assumed here; those cases may change when the owner answers. Size limits (Q1) and
the token-symbol allowlist (Q2) have no vectors at all, and a lone surrogate has none either (the
harness JSON loader refuses one in a vector file, see generate_pairing_bodies.py).
  Q1  Size limits: 04 §3.4 and 06 §2.2a defer to M1-21, which does not state them.
  Q2  Currency: the allowlisted token symbols are not listed; is `^[A-Z]{3}$` a grammar only (ABC
      accepted) or the ISO 4217 code list? Assumed: grammar only.
  Q3  Key presence: assumed `price` is optional and absent when none (null refused); `deadlines` and
      `deliverables[].plaintextSha256` are always present (`[]`, null); the body's `note` is always
      present (null). The jsonc does not say which keys may be omitted.
  Q4  `parties` order is hashed. Assumed: any order is accepted on parse; the two must differ; the
      mapping writes [own agent, contact].
  Q5  U+007F DEL is Cc but neither C0 (U+0000-U+001F) nor C1 (U+0080-U+009F). Assumed refused.
  Q6  U+2028/U+2029 (Zl, Zp) are refused in `approval-request.summary` but not listed for terms.
      Assumed accepted (literal reading); likely worth refusing.
  Q7  Unassigned code points and noncharacters (Cn) are not listed. Assumed accepted. The Cf and NFC
      checks depend on each runtime's Unicode version; these vectors use code points stable since
      Unicode 6.3 or earlier.
  Q8  RFC 3339 allows a leap second (`:60`). Assumed refused (strict UTC calendar time).
  Q9  `deadlines[].ref` naming no deliverable is refused only in 06 §2.2a ("ref = a deliverable id"),
      not in 04's list. Assumed refused. Duplicate refs: no vector.
  Q10 Empty strings and an empty `deliverables` list: 06 says "at least one" deliverable for
      TermsInput only. Assumed refused for `terms` too; empty strings have no vector.
  Q11 `version` 0 and pointer/version consistency (version 1 with a pointer, version 2 with null):
      assumed `version` >= 1 at parse; consistency is a chain check only.
  Q12 TermsInput `validUntil` is "ISO 8601" but `terms.validUntil` is unix seconds: which ISO forms
      (offsets, fractions), how converted, and is the default exactly now + 604 800? Assumed the
      strict `YYYY-MM-DDTHH:MM:SSZ` form and exactly 7 * 86 400 s; mixing given and default ids has
      no vector.
  Q13 How a received `accept` names the offer it answers. Assumed by `replyTo`; an accept of the
      receiver's own superseded offer is stored as valid (06 §2.2a path (b) shows a warning).
  Q14 `validUntil` boundary: assumed the terms are within `validUntil` at now == validUntil
      ("the terms lapse after this").
  Q15 After a version is accepted, may either side offer version n + 1? Assumed yes: only the
      accepted version is locked.
  Q16 The same envelope (same id) delivered twice through two relays is not "a second, different
      envelope". No vector.
  Q17 After a conflict "either side may send that version number again" (rule 3) but rule 1 refuses
      a second envelope for a version from the same sender. Assumed rule 3 wins for the conflicted
      version.
  Q18 Whether the canonical-form rules apply to `note`. No vector.

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
S_ENC = "04 §2.4.1 canonical encodings"
S_HASH = "04 §3.4 termsHash = sha256(JCS(terms)), 04 §3.1 RFC 8785"
S_BODY = "04 §3.4 body of offer / accept / reject"
S_INPUT = "06 §2.2a TermsInput (D-55)"
S_CHAIN = "04 §3.4 negotiation chain (D-55)"
S_ACCEPT = "04 §3.4 sending an accept (D-55)"


def oq(n, assumed):
    return f"OPEN QUESTION Q{n} (assumed: {assumed}): "


# --- the reference parser (04 §2.4.1, §3.4) ------------------------------------------------------

TERMS_KEYS = {"termsId", "version", "parties", "subject", "deliverables", "price", "deadlines", "validUntil", "previousTermsHash"}
TERMS_REQUIRED = TERMS_KEYS - {"price"}  # Q3
DELIVERABLE_KEYS = {"id", "description", "by", "plaintextSha256"}
PRICE_KEYS = {"amount", "currency", "payer"}
DEADLINE_KEYS = {"ref", "due"}
BIDI = {0x200E, 0x200F, *range(0x202A, 0x202F), *range(0x2066, 0x206A)}
AMOUNT = re.compile(r"(0|[1-9][0-9]*)(\.[0-9]{1,6})?")
DUE = re.compile(r"([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})Z")
ADDRESS = re.compile(r"0x[0-9a-f]{40}")
HEX64 = re.compile(r"[0-9a-f]{64}")


def check_string(value):
    if not isinstance(value, str):
        raise ValueError("not a string")
    for ch in value:
        cp = ord(ch)
        if cp <= 0x1F or 0x7F <= cp <= 0x9F:  # C0, DEL (Q5), C1
            raise ValueError("control character")
        if 0xD800 <= cp <= 0xDFFF:
            raise ValueError("lone surrogate")
        if cp in BIDI:
            raise ValueError("bidi control")
        category = unicodedata.category(ch)
        if category == "Cf":
            raise ValueError("format character")
        if category == "Co":
            raise ValueError("private use")
    if not unicodedata.is_normalized("NFC", value):
        raise ValueError("not NFC")
    return value


def check_integer(value, minimum=0):
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
    if hour > 23 or minute > 59 or second > 59:  # Q8: no leap second
        raise ValueError("due: no such time")
    return calendar.timegm((year, month, day, hour, minute, second))


def check_amount(value):
    check_string(value)
    if not AMOUNT.fullmatch(value) or set(value) <= {"0", "."}:
        raise ValueError("amount: not a positive canonical decimal")
    return value


def check_currency(value):
    check_string(value)
    if not re.fullmatch(r"[A-Z]{3}", value):  # Q2: no token symbols known
        raise ValueError("currency")
    return value


def exact_keys(obj, allowed, required):
    if not isinstance(obj, dict) or not set(obj) <= allowed or not required <= set(obj):
        raise ValueError("wrong keys")


def parse_terms(terms):
    exact_keys(terms, TERMS_KEYS, TERMS_REQUIRED)
    check_string(terms["termsId"])
    if len(v.unb64u(terms["termsId"])) != 16:
        raise ValueError("termsId: not 16 bytes")
    check_integer(terms["version"], minimum=1)  # Q11
    parties = terms["parties"]
    if not isinstance(parties, list) or len(parties) != 2:
        raise ValueError("parties: not two")
    for p in parties:
        check_string(p)
        if not ADDRESS.fullmatch(p):
            raise ValueError("party: not 0x + 40 lowercase hex")
    if parties[0] == parties[1]:  # Q4
        raise ValueError("parties: the same agent twice")
    check_string(terms["subject"])
    deliverables = terms["deliverables"]
    if not isinstance(deliverables, list) or not deliverables:  # Q10
        raise ValueError("deliverables: not a non-empty list")
    ids = []
    for d in deliverables:
        exact_keys(d, DELIVERABLE_KEYS, DELIVERABLE_KEYS)
        check_string(d["id"])
        check_string(d["description"])
        check_string(d["by"])
        if d["by"] not in parties:
            raise ValueError("by: not a party")
        if d["plaintextSha256"] is not None:
            check_string(d["plaintextSha256"])
            if not HEX64.fullmatch(d["plaintextSha256"]):
                raise ValueError("plaintextSha256")
        ids.append(d["id"])
    if len(set(ids)) != len(ids):
        raise ValueError("deliverables: duplicate id")
    if "price" in terms:
        price = terms["price"]
        exact_keys(price, PRICE_KEYS, PRICE_KEYS)
        check_amount(price["amount"])
        check_currency(price["currency"])
        check_string(price["payer"])
        if price["payer"] not in parties:
            raise ValueError("payer: not a party")
    deadlines = terms["deadlines"]
    if not isinstance(deadlines, list):
        raise ValueError("deadlines: not a list")
    for dl in deadlines:
        exact_keys(dl, DEADLINE_KEYS, DEADLINE_KEYS)
        check_string(dl["ref"])
        if dl["ref"] not in ids:  # Q9
            raise ValueError("ref: no such deliverable")
        check_due(dl["due"])
    check_integer(terms["validUntil"])
    prev = terms["previousTermsHash"]
    if prev is not None:
        check_string(prev)
        if not HEX64.fullmatch(prev):
            raise ValueError("previousTermsHash")
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

BODY_KEYS = {"terms", "termsHash", "note"}


def parse_body(type_, body):
    if type_ not in ("offer", "accept", "reject"):
        raise ValueError("type")
    exact_keys(body, BODY_KEYS, BODY_KEYS)  # Q3: note always present
    parse_terms(body["terms"])
    if not isinstance(body["termsHash"], str) or not HEX64.fullmatch(body["termsHash"]):
        raise ValueError("termsHash: not 64 lowercase hex")
    if body["termsHash"] != terms_hash(body["terms"]):
        raise ValueError("termsHash mismatch")
    note = body["note"]
    if note is not None and (not isinstance(note, str) or type_ == "accept"):
        raise ValueError("note")
    return body["termsHash"]


# --- TermsInput (06 §2.2a) and its mapping --------------------------------------------------------

INPUT_KEYS = {"subject", "deliverables", "price", "deadlines", "validUntil"}
INPUT_DELIVERABLE_KEYS = {"id", "description", "by", "plaintextSha256"}


def parse_input(ti):
    exact_keys(ti, INPUT_KEYS, {"subject", "deliverables"})
    check_string(ti["subject"])
    ds = ti["deliverables"]
    if not isinstance(ds, list) or not ds:
        raise ValueError("deliverables")
    ids = []
    for i, d in enumerate(ds):
        exact_keys(d, INPUT_DELIVERABLE_KEYS, {"description", "by"})
        check_string(d["description"])
        if d["by"] not in ("me", "them"):
            raise ValueError("by")
        if "plaintextSha256" in d:
            check_string(d["plaintextSha256"])
            if not HEX64.fullmatch(d["plaintextSha256"]):
                raise ValueError("plaintextSha256")
        if "id" in d:
            check_string(d["id"])
        ids.append(d.get("id", f"d{i + 1}"))
    if len(set(ids)) != len(ids):
        raise ValueError("duplicate id")
    if "price" in ti:
        p = ti["price"]
        exact_keys(p, PRICE_KEYS, PRICE_KEYS)
        check_amount(p["amount"])
        check_currency(p["currency"])
        if p["payer"] not in ("me", "them"):
            raise ValueError("payer")
    if "deadlines" in ti:
        if not isinstance(ti["deadlines"], list):
            raise ValueError("deadlines")
        for dl in ti["deadlines"]:
            exact_keys(dl, DEADLINE_KEYS, DEADLINE_KEYS)
            check_string(dl["ref"])
            if dl["ref"] not in ids:
                raise ValueError("ref")
            check_due(dl["due"])
    if "validUntil" in ti:
        check_due(ti["validUntil"])  # Q12
    return ti


def map_input(ti, ctx):
    parse_input(ti)
    who = {"me": ctx["me"], "them": ctx["them"]}
    deliverables = [
        {"id": d.get("id", f"d{i + 1}"), "description": d["description"], "by": who[d["by"]], "plaintextSha256": d.get("plaintextSha256")}
        for i, d in enumerate(ti["deliverables"])
    ]
    terms = {
        "termsId": ctx["termsId"],
        "version": ctx["version"],
        "parties": [ctx["me"], ctx["them"]],  # Q4
        "subject": ti["subject"],
        "deliverables": deliverables,
        "deadlines": [dict(dl) for dl in ti.get("deadlines", [])],  # Q3
        "validUntil": check_due(ti["validUntil"]) if "validUntil" in ti else ctx["now"] + WEEK,  # Q12
        "previousTermsHash": ctx["previousTermsHash"],
    }
    if "price" in ti:
        p = ti["price"]
        terms["price"] = {"amount": p["amount"], "currency": p["currency"], "payer": who[p["payer"]]}
    parse_terms(terms)
    return terms


# --- the reference chain model (04 §3.4, D-55) ---------------------------------------------------


class Chain:
    """One core's view, replayed from its log. Per key (termsId, unordered pair): the valid offers by
    version, the (sender, version) pairs seen, locked versions, and conflicted versions."""

    def __init__(self, me):
        self.me = me
        self.keys = {}
        self.envelopes = {}  # id -> (envelope, status)

    def state(self, key):
        return self.keys.setdefault(key, {"chain": {}, "seen": {}, "locked": set(), "conflicted": {}})

    @staticmethod
    def key_of(terms):
        return (terms["termsId"], frozenset(terms["parties"]))

    def newest(self, key):
        chain = self.state(key)["chain"]
        if not chain:
            return 0, None
        version = max(chain)
        return version, chain[version]["hash"]

    def apply(self, direction, env):
        status = self._apply(direction, env)
        self.envelopes[env["id"]] = (env, status)
        return status

    def _apply(self, direction, env):
        body, type_ = env["body"], env["type"]
        try:
            parse_body(type_, body)
        except (ValueError, KeyError, TypeError):
            return "refused"
        terms = body["terms"]
        sender, receiver = env["from"], env["to"]
        if set(terms["parties"]) != {sender, receiver} or self.me not in (sender, receiver):
            return "refused"
        key = self.key_of(terms)
        st = self.state(key)
        version, h = terms["version"], body["termsHash"]
        if type_ == "offer":
            if direction == "sent":
                st["chain"][version] = {"hash": h, "from": sender, "id": env["id"], "prev": terms["previousTermsHash"]}
                st["seen"][(sender, version)] = env["id"]
                return "valid"
            if version in st["locked"]:
                return "refused"  # rule 2
            if (sender, version) in st["seen"] and version not in st["conflicted"]:
                return "refused"  # rule 1
            newest_v, newest_h = self.newest(key)
            mine = st["chain"].get(newest_v)
            if (
                mine is not None
                and newest_v == version
                and mine["from"] == self.me
                and mine["prev"] == terms["previousTermsHash"]
            ):
                # rule 3: concurrent counters for the same version; the previous version stays newest
                del st["chain"][newest_v]
                st["conflicted"][version] = True
                st["seen"].pop((self.me, version), None)
                return "conflict"
            if version == newest_v + 1 and terms["previousTermsHash"] == newest_h:
                st["chain"][version] = {"hash": h, "from": sender, "id": env["id"], "prev": terms["previousTermsHash"]}
                st["seen"][(sender, version)] = env["id"]
                st["conflicted"].pop(version, None)
                return "valid"
            return "refused"
        # accept or reject: answers an offer named by replyTo (Q13)
        answered = self.envelopes.get(env.get("replyTo"))
        if answered is None or answered[1] != "valid" or answered[0]["type"] != "offer":
            return "refused"
        offer = answered[0]
        if offer["from"] != receiver or offer["to"] != sender or offer["body"]["termsHash"] != h:
            return "refused"
        if type_ == "accept":
            if version in st["locked"]:
                return "refused"  # rule 2: one accept per version
            st["locked"].add(version)
        return "valid"

    def replay(self, log):
        for entry in log:
            self.apply(entry["dir"], entry["envelope"])
        return self


def chain_receive(me, log, incoming):
    chain = Chain(me).replay(log)
    outcome = chain.apply("received", incoming)
    terms = incoming["body"]["terms"]
    version, h = chain.newest(Chain.key_of(terms))
    return outcome, version, h


def next_offer(me, contact, terms_id, log):
    chain = Chain(me).replay(log)
    version, h = chain.newest((terms_id, frozenset({me, contact})))
    return version + 1, h


def send_accept(me, now, log, answers):
    chain = Chain(me).replay(log)
    if answers not in chain.envelopes:
        return None
    env, status = chain.envelopes[answers]
    if status != "valid" or env["type"] != "offer" or env["to"] != me:
        return None
    terms = env["body"]["terms"]
    key = Chain.key_of(terms)
    newest_v, newest_h = chain.newest(key)
    if terms["version"] != newest_v or env["body"]["termsHash"] != newest_h:
        return None  # superseded
    if terms["version"] in chain.state(key)["locked"]:
        return None
    if now > terms["validUntil"]:  # Q14
        return None
    if set(terms["parties"]) != {me, env["from"]}:
        return None
    return env["body"]["termsHash"]


# --- fixtures ------------------------------------------------------------------------------------

A = v.evm_address(v.det("terms/agent-a", 32))
B = v.evm_address(v.det("terms/agent-b", 32))
C = v.evm_address(v.det("terms/agent-c", 32))
TID = v.b64u(v.det("terms/terms-id/1", 16))
TID2 = v.b64u(v.det("terms/terms-id/2", 16))
B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
DIGEST = v.hx(v.sha256(b"agentlink-test-vectors/terms/d2-plaintext"))
VALID_UNTIL = NOW + WEEK


def base_terms(**over):
    t = {
        "termsId": TID,
        "version": 1,
        "parties": [A, B],
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


def env(label, sender, to, type_, terms, reply_to=None, note=None):
    return {
        "id": v.b64u(v.det(f"terms/envelope/{label}", 16)),
        "from": sender,
        "to": to,
        "type": type_,
        "replyTo": reply_to,
        "body": body_of(terms, note),
    }


def sent(e):
    return {"dir": "sent", "envelope": e}


def received(e):
    return {"dir": "received", "envelope": e}


# --- cases ---------------------------------------------------------------------------------------


def build():
    v.check_eip55()  # the pinned keccak agrees with the published EIP-55 examples
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
    minimal = base_terms(deadlines=[], deliverables=[base["deliverables"][0]])
    del minimal["price"]
    terms_case("accept-minimal", oq(3, "price absent, deadlines []") + f"{S_TERMS}: no price, no deadlines, one deliverable", minimal, True)
    v2 = base_terms(version=2, previousTermsHash=base_hash, parties=[B, A])
    terms_case("accept-version-2", f"{S_TERMS}: version 2 pointing at version 1's termsHash, parties in the other order", v2, True)
    terms_case(
        "accept-unicode",
        f"{S_CANON}: NFC text with a precomposed \u00e9, CJK, an astral emoji, U+FE0F (Mn), a no-break space and a ligature (NFC, not NFKC)",
        with_path(base, ["subject"], "Caf\u00e9 \u5951\u7d04 \U0001f91d\ufe0f\u00a0\ufb01nal"),
        True,
    )
    terms_case("accept-amount-integer", f"{S_CANON}: amount \"1\"", with_path(base, ["price", "amount"], "1"), True)
    terms_case("accept-amount-6-decimals", f"{S_CANON}: amount \"0.000001\" (6 decimals, > 0)", with_path(base, ["price", "amount"], "0.000001"), True)
    terms_case("accept-amount-trailing-zeros", f"{S_CANON}, 04 §2.4.1 Other decimal amounts: \"1500.000000\" keeps its trailing zeros", with_path(base, ["price", "amount"], "1500.000000"), True)
    terms_case(
        "accept-amount-large",
        oq(1, "no bound below 40 digits") + f"{S_ENC} Other decimal amounts: no fixed upper bound beyond the size limits",
        with_path(base, ["price", "amount"], "1234567890123456789012345678901234567890.5"),
        True,
    )
    terms_case("accept-currency-not-iso", oq(2, "a grammar, not the ISO 4217 list") + f"{S_CANON}: currency \"ABC\" matches ^[A-Z]{{3}}$", with_path(base, ["price", "currency"], "ABC"), True)
    terms_case("accept-due-leap-day", f"{S_CANON}: due 2028-02-29T00:00:00Z (a leap day)", with_path(base, ["deadlines", 0, "due"], "2028-02-29T00:00:00Z"), True)
    terms_case("accept-valid-until-zero", f"{S_ENC}: validUntil 0 is a JSON integer in range (expiry is a chain check)", with_path(base, ["validUntil"], 0), True)
    terms_case("accept-valid-until-max", f"{S_ENC}: validUntil 2^53 - 1", with_path(base, ["validUntil"], MAX_INT), True)
    terms_case("accept-line-separator", oq(6, "U+2028 accepted for terms") + f"{S_CANON}: a U+2028 LINE SEPARATOR (Zl) in a description", with_path(base, ["deliverables", 0, "description"], "line\u2028two"), True)
    terms_case("accept-noncharacter", oq(7, "Cn accepted") + f"{S_CANON}: a noncharacter U+FDD0 in the subject", with_path(base, ["subject"], "x\ufdd0y"), True)
    terms_case("accept-unassigned", oq(7, "Cn accepted") + f"{S_CANON}: U+0378 (unassigned since Unicode 1.1) in the subject", with_path(base, ["subject"], "x\u0378y"), True)

    # 2. Every covered field changes the hash (each is a valid variant of `base` with its own hash).
    variants = [
        ("terms-id", ["termsId"], TID2),
        ("version", ["version"], 2),
        ("parties-order", ["parties"], [B, A]),
        ("subject", ["subject"], "Spec v2 \u2013 milestone 4"),
        ("deliverable-id", ["deliverables", 1, "id"], "d3"),
        ("deliverable-description", ["deliverables", 0, "description"], "Milestone 3 report, final"),
        ("deliverable-by", ["deliverables", 0, "by"], A),
        ("deliverable-plaintext-sha256", ["deliverables", 0, "plaintextSha256"], DIGEST),
        ("deliverables-order", ["deliverables"], list(reversed(base["deliverables"]))),
        ("price-amount", ["price", "amount"], "1500.0"),
        ("price-currency", ["price", "currency"], "USD"),
        ("price-payer", ["price", "payer"], B),
        ("deadline-due", ["deadlines", 0, "due"], "2026-11-30T17:00:01Z"),
        ("deadline-ref", ["deadlines", 0, "ref"], "d2"),
        ("deadlines-empty", ["deadlines"], []),
        ("valid-until", ["validUntil"], VALID_UNTIL + 1),
        ("previous-terms-hash", ["previousTermsHash"], DIGEST),
    ]
    hashes = {base_hash}
    for slug, path, value in variants:
        t = with_path(base, path, value)
        h = terms_hash(t)
        if h in hashes:
            v.fail(f"covered field {slug}: the hash did not change")
        hashes.add(h)
        q = oq(11, "version/pointer consistency is a chain check") if slug in ("version", "previous-terms-hash") else ""
        terms_case(f"accept-changed-{slug}", q + f"{S_HASH}: a covered field changes the hash ({slug} differs from terms-accept-base)", t, True)
    no_price = copy.deepcopy(base)
    del no_price["price"]
    terms_case("accept-changed-price-absent", oq(3, "price may be absent") + f"{S_HASH}: removing price changes the hash", no_price, True)

    # 3. Canonical-form rejections (04 §3.4) on each string path.
    reject_strings = [
        ("rlo-subject", ["subject"], "Spec v2 \u202emilestone 3", "U+202E RIGHT-TO-LEFT OVERRIDE in subject"),
        ("zwsp-description", ["deliverables", 0, "description"], "Milestone\u200b3 report", "U+200B ZERO WIDTH SPACE in a deliverable description"),
        ("cyrillic-currency", ["price", "currency"], "\u0415UR", "Cyrillic \u0415UR (U+0415) as currency"),
        ("nul-subject", ["subject"], "a\u0000b", "U+0000 (C0)"),
        ("tab-subject", ["subject"], "a\tb", "U+0009 TAB (C0)"),
        ("newline-description", ["deliverables", 0, "description"], "line one\nline two", "U+000A LINE FEED (C0) in a description"),
        ("cr-description", ["deliverables", 0, "description"], "a\rb", "U+000D (C0)"),
        ("us-subject", ["subject"], "a\u001fb", "U+001F (C0)"),
        ("nel-subject", ["subject"], "a\u0085b", "U+0085 NEXT LINE (C1)"),
        ("csi-subject", ["subject"], "a\u009b31mb", "U+009B CSI (C1)"),
        ("zwnj-description", ["deliverables", 0, "description"], "a\u200cb", "U+200C ZERO WIDTH NON-JOINER (Cf)"),
        ("zwj-emoji-subject", ["subject"], "\U0001f468\u200d\U0001f469\u200d\U0001f467", "an emoji ZWJ sequence: U+200D is Cf, so it is refused"),
        ("word-joiner", ["subject"], "a\u2060b", "U+2060 WORD JOINER (Cf)"),
        ("bom-subject", ["subject"], "\ufeffSpec", "U+FEFF BYTE ORDER MARK (Cf) at the start"),
        ("soft-hyphen", ["subject"], "mile\u00adstone", "U+00AD SOFT HYPHEN (Cf)"),
        ("arabic-letter-mark", ["subject"], "a\u061cb", "U+061C ARABIC LETTER MARK (Cf, a bidi mark outside the listed ranges)"),
        ("mongolian-vowel-separator", ["subject"], "a\u180eb", "U+180E MONGOLIAN VOWEL SEPARATOR (Cf since Unicode 6.3)"),
        ("tag-character", ["subject"], "a\U000e0041b", "U+E0041 TAG LATIN CAPITAL LETTER A (Cf)"),
        ("private-use-bmp", ["subject"], "a\ue000b", "U+E000 (private use)"),
        ("private-use-f8ff", ["deliverables", 0, "description"], "a\uf8ffb", "U+F8FF (private use)"),
        ("private-use-plane-15", ["subject"], "a\U000f0000b", "U+F0000 (supplementary private use A)"),
        ("private-use-plane-16", ["subject"], "a\U0010fffdb", "U+10FFFD (supplementary private use B)"),
        ("nfd-subject", ["subject"], "Cafe\u0301", "e + U+0301 (NFD, not NFC)"),
        ("angstrom-sign", ["deliverables", 0, "description"], "5 \u212b", "U+212B ANGSTROM SIGN (NFC maps it to U+00C5)"),
        ("ohm-sign", ["subject"], "10 \u2126", "U+2126 OHM SIGN (NFC maps it to U+03A9)"),
        ("nfd-deliverable-id", ["deliverables", 0, "id"], "e\u0301", "e + U+0301 (NFD) in a deliverable id"),
        ("rlo-deliverable-id", ["deliverables", 0, "id"], "d1\u202e", "U+202E in a deliverable id"),
        ("zwsp-deadline-ref", ["deadlines", 0, "ref"], "d1\u200b", "U+200B in a deadline ref"),
    ]
    for cp in [0x200E, 0x200F, 0x202A, 0x202B, 0x202C, 0x202D, 0x202E, 0x2066, 0x2067, 0x2068, 0x2069]:
        reject_strings.append((f"bidi-{cp:04x}", ["subject"], f"Spec {chr(cp)}v2", f"bidi control U+{cp:04X} in subject"))
    for slug, path, value, why in reject_strings:
        t = with_path(base, path, value)
        if path == ["deliverables", 0, "id"]:
            t = with_path(t, ["deadlines", 0, "ref"], value)  # the ref names the same id, so only the string rule refuses it
        terms_case(f"reject-{slug}", f"{S_CANON}: {why}", t, False)
    terms_case("reject-del", oq(5, "U+007F refused") + f"{S_CANON}: U+007F DELETE in subject", with_path(base, ["subject"], "a\u007fb"), False)

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
        ("lowercase", "eur", "in lower case"),
        ("four-letters", "EURO", "four letters"),
        ("two-letters", "EU", "two letters"),
        ("trailing-space", "EUR ", "a trailing space"),
        ("fullwidth", "\uff25\uff35\uff32", "full-width EUR"),
        ("symbol", "\u20ac", "the euro sign"),
        ("digits", "978", "the ISO 4217 numeric code"),
    ]:
        terms_case(f"reject-currency-{slug}", f"{S_CANON}: price.currency {why}", with_path(base, ["price", "currency"], value), False)

    # Parties, payer and by.
    terms_case("reject-payer-not-party", f"{S_CANON}: price.payer is not one of the parties", with_path(base, ["price", "payer"], C), False)
    terms_case("reject-by-not-party", f"{S_CANON}: deliverables[].by is not one of the parties", with_path(base, ["deliverables", 0, "by"], C), False)
    terms_case("reject-duplicate-deliverable-id", f"{S_CANON}: two deliverables with id d1", with_path(base, ["deliverables", 1, "id"], "d1"), False)
    terms_case("reject-payer-uppercase", f"{S_ENC}: price.payer in upper-case hex", with_path(base, ["price", "payer"], "0x" + A[2:].upper()), False)
    terms_case("reject-payer-checksummed", f"{S_ENC}: price.payer EIP-55 checksummed", with_path(base, ["price", "payer"], v.eip55(A)), False)
    terms_case("reject-by-checksummed", f"{S_ENC}: deliverables[].by EIP-55 checksummed", with_path(base, ["deliverables", 0, "by"], v.eip55(B)), False)
    if v.eip55(A) == A or v.eip55(B) == B:
        v.fail("a fixture address has no upper-case letter in its checksum form")
    for slug, parties, why in [
        ("uppercase", [A, "0x" + B[2:].upper()], "a party in upper-case hex"),
        ("checksummed", [v.eip55(A), B], "a party EIP-55 checksummed"),
        ("no-prefix", [A, B[2:]], "a party without 0x"),
        ("capital-0x", [A, "0X" + B[2:]], "a party with 0X"),
        ("short", [A, B[:-2]], "a party of 19 bytes"),
        ("three", [A, B, C], "three parties (two in beta)"),
        ("one", [A], "one party"),
        ("same-twice", [A, A], "the same agent twice"),
    ]:
        t = with_path(base, ["parties"], parties)
        if slug == "same-twice":
            t = with_path(t, ["deliverables", 0, "by"], A)  # every by and payer is a party, so only distinctness refuses it
        terms_case(f"reject-parties-{slug}", (oq(4, "the two parties differ") if slug == "same-twice" else "") + f"{S_ENC}, {S_TERMS}: {why}", t, False)

    # Dates.
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
        ("short-year", "26-11-30T17:00:00Z", "a two-digit year"),
        ("unpadded", "2026-11-3T17:00:00Z", "an unpadded day"),
    ]:
        terms_case(f"reject-due-{slug}", f"{S_CANON}: deadlines[].due {why}", with_path(base, ["deadlines", 0, "due"], value), False)
    terms_case("reject-due-leap-second", oq(8, "no leap second") + f"{S_CANON}: deadlines[].due 2016-12-31T23:59:60Z", with_path(base, ["deadlines", 0, "due"], "2016-12-31T23:59:60Z"), False)
    terms_case("reject-due-integer", f"{S_CANON}: deadlines[].due as unix seconds", with_path(base, ["deadlines", 0, "due"], 1796058000), False)
    terms_case("reject-deadline-unknown-ref", oq(9, "ref must name a deliverable") + f"{S_INPUT}: a deadline ref that names no deliverable", with_path(base, ["deadlines", 0, "ref"], "d9"), False)

    # Hex, base64url and integers.
    for slug, path, value, why in [
        ("plaintext-sha256-uppercase", ["deliverables", 1, "plaintextSha256"], DIGEST.upper(), "plaintextSha256 in upper-case hex"),
        ("plaintext-sha256-0x", ["deliverables", 1, "plaintextSha256"], "0x" + DIGEST, "plaintextSha256 with 0x"),
        ("plaintext-sha256-short", ["deliverables", 1, "plaintextSha256"], DIGEST[:-2], "plaintextSha256 of 31 bytes"),
        ("plaintext-sha256-base64url", ["deliverables", 1, "plaintextSha256"], v.b64u(bytes.fromhex(DIGEST)), "plaintextSha256 as base64url"),
        ("previous-uppercase", ["previousTermsHash"], DIGEST.upper(), "previousTermsHash in upper-case hex"),
        ("previous-0x", ["previousTermsHash"], "0x" + DIGEST, "previousTermsHash with 0x"),
        ("previous-long", ["previousTermsHash"], DIGEST + "00", "previousTermsHash of 33 bytes"),
        ("terms-id-padded", ["termsId"], TID + "==", "termsId with padding"),
        ("terms-id-15-bytes", ["termsId"], v.b64u(v.det("terms/terms-id/short", 15)), "termsId of 15 bytes"),
        ("terms-id-17-bytes", ["termsId"], v.b64u(v.det("terms/terms-id/long", 17)), "termsId of 17 bytes"),
        ("terms-id-hex", ["termsId"], v.hx(v.det("terms/terms-id/1", 16)), "termsId as hex"),
        ("terms-id-standard-alphabet", ["termsId"], "+/" + TID[2:], "termsId with + and /"),
        ("terms-id-trailing-bits", ["termsId"], TID[:-1] + B64_ALPHABET[B64_ALPHABET.index(TID[-1]) + 1], "termsId with non-zero trailing bits"),
        ("version-zero", ["version"], 0, "version 0"),
        ("version-string", ["version"], "1", "version as a string"),
        ("version-negative", ["version"], -1, "version -1"),
        ("version-2-53", ["version"], 2**53, "version 2^53"),
        ("valid-until-string", ["validUntil"], str(VALID_UNTIL), "validUntil as a string"),
        ("valid-until-negative", ["validUntil"], -1, "validUntil -1"),
        ("valid-until-2-53", ["validUntil"], 2**53, "validUntil 2^53"),
        ("valid-until-iso", ["validUntil"], "2026-09-28T14:13:20Z", "validUntil as an ISO date (unix seconds in terms)"),
    ]:
        source = (oq(11, "version >= 1") if slug == "version-zero" else "") + f"{S_ENC}: {why}"
        terms_case(f"reject-{slug}", source, with_path(base, path, value), False)

    # Structure: unknown and missing keys, nulls, empty lists.
    terms_case("reject-unknown-key", f"{S_TERMS}: an unknown top-level key", with_path(base, ["note"], "x"), False)
    terms_case("reject-terms-hash-inside", f"{S_TERMS}: termsHash inside terms", with_path(base, ["termsHash"], base_hash), False)
    terms_case("reject-unknown-deliverable-key", f"{S_TERMS}: an unknown key in a deliverable", with_path(base, ["deliverables", 0, "price"], "1"), False)
    terms_case("reject-unknown-price-key", f"{S_TERMS}: an unknown key in price", with_path(base, ["price", "usd"], "1"), False)
    terms_case("reject-unknown-deadline-key", f"{S_TERMS}: an unknown key in a deadline", with_path(base, ["deadlines", 0, "tz"], "UTC"), False)
    for key in sorted(TERMS_REQUIRED):
        slug = re.sub(r"([a-z])([A-Z])", r"\1-\2", key).lower()
        q = oq(3, f"{key} always present") if key in ("deadlines",) else ""
        terms_case(f"reject-missing-{slug}", q + f"{S_TERMS}: {key} missing", with_path(base, [key], None, delete=True), False)
    terms_case("reject-missing-plaintext-sha256", oq(3, "plaintextSha256 always present, null when none") + f"{S_TERMS}: a deliverable without plaintextSha256", with_path(base, ["deliverables", 0, "plaintextSha256"], None, delete=True), False)
    terms_case("reject-missing-payer", f"{S_TERMS}, D-55: price without payer", with_path(base, ["price", "payer"], None, delete=True), False)
    terms_case("reject-missing-by", f"{S_TERMS}, D-55: a deliverable without by", with_path(base, ["deliverables", 0, "by"], None, delete=True), False)
    terms_case("reject-price-null", oq(3, "price absent, never null") + f"{S_TERMS}: price null", with_path(base, ["price"], None), False)
    terms_case("reject-deliverables-empty", oq(10, "at least one deliverable") + f"{S_TERMS}: no deliverables", with_path(base, ["deliverables"], []), False)
    terms_case("reject-subject-number", f"{S_TERMS}: subject as a number", with_path(base, ["subject"], 3), False)
    terms_case("reject-subject-null", f"{S_TERMS}: subject null", with_path(base, ["subject"], None), False)
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
    json_case("accept-pretty", f"{S_HASH}: indented with spaces, tabs, CRLF line ends; the hash is unchanged", json.dumps(reorder(base), indent="\t", ensure_ascii=False).replace("\n", "\r\n  "), True, base_hash)
    json_case("accept-escaped", f"{S_HASH}: \\u escapes for non-ASCII and for ASCII letters; the hash is unchanged", json.dumps(base, indent=1, ensure_ascii=True).replace('"EUR"', '"\\u0045UR"').replace('"d1"', '"\\u00641"'), True, base_hash)
    for case_id, why, old, new in [
        ("version-fraction", "version spelled 1.0", '"version":1,', '"version":1.0,'),
        ("version-exponent", "version spelled 1e0", '"version":1,', '"version":1e0,'),
        ("version-minus-zero", "version spelled -0 (and 0 is refused anyway)", '"version":1,', '"version":-0,'),
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
    body_case("accept-offer", f"{S_BODY}: an offer, note null", "offer", b, True)
    body_case("accept-offer-note", f"{S_BODY}: an offer with a note; the note is not covered by termsHash", "offer", body_of(base, "Happy to discuss the deadline."), True)
    body_case("accept-reject-note", f"{S_BODY}: a reject with a note", "reject", body_of(base, "Too expensive."), True)
    body_case("accept-accept", f"{S_BODY}: an accept, note null", "accept", b, True)
    body_case("reject-accept-note", f"{S_BODY}: a note on an accept", "accept", body_of(base, "Agreed."), False)
    body_case("reject-hash-mismatch", f"{S_BODY}: termsHash of other terms (the core recomputes it)", "offer", {**b, "termsHash": terms_hash(v2)}, False)
    body_case("reject-hash-of-pretty-text", f"{S_BODY}: termsHash over indented text, not JCS", "offer", {**b, "termsHash": v.hx(v.sha256(json.dumps(base, indent=2).encode()))}, False)
    body_case("reject-hash-uppercase", f"{S_BODY}, {S_ENC}: termsHash in upper-case hex", "offer", {**b, "termsHash": base_hash.upper()}, False)
    body_case("reject-hash-0x", f"{S_BODY}, {S_ENC}: termsHash with 0x", "offer", {**b, "termsHash": "0x" + base_hash}, False)
    body_case("reject-hash-missing", f"{S_BODY}: termsHash missing", "offer", {"terms": base, "note": None}, False)
    body_case("reject-note-missing", oq(3, "note always present") + f"{S_BODY}: note missing", "offer", {"terms": base, "termsHash": base_hash}, False)
    body_case("reject-unknown-key", f"{S_BODY}: an unknown body key", "offer", {**b, "extra": 1}, False)
    body_case("reject-terms-invalid", f"{S_BODY}, {S_CANON}: terms with an RLO in subject, whatever the quoted hash", "offer", body_of(with_path(base, ["subject"], "a\u202eb")), False)
    body_case("reject-note-number", f"{S_BODY}: note as a number", "reject", body_of(base, 7), False)

    # 6. TermsInput (06 §2.2a): the agent supplies only these fields.
    ti = {
        "subject": "Spec v2 \u2013 milestone 3",
        "deliverables": [
            {"id": "d1", "description": "Milestone 3 report", "by": "them"},
            {"id": "d2", "description": "Review of the report", "by": "me", "plaintextSha256": DIGEST},
        ],
        "price": {"amount": "1500.00", "currency": "EUR", "payer": "me"},
        "deadlines": [{"ref": "d1", "due": "2026-11-30T17:00:00Z"}],
        "validUntil": "2026-09-28T14:13:20Z",
    }
    if calendar.timegm((2026, 9, 28, 14, 13, 20)) != VALID_UNTIL:
        v.fail("validUntil fixture")

    def input_case(case_id, source, termsinput, accept):
        ok = accepts(parse_input, termsinput)
        if ok != accept:
            v.fail(f"input {case_id}: the reference {'accepts' if ok else 'rejects'} it")
        add(f"input-{case_id}", source, {"op": "parseTermsInput", "termsInput": termsinput}, {"outcome": "accept" if accept else "reject"})

    input_case("accept-full", f"{S_INPUT}: every field", ti, True)
    input_case("accept-minimal", f"{S_INPUT}: subject and one deliverable, no id", {"subject": "x", "deliverables": [{"description": "y", "by": "me"}]}, True)
    for key, value in [
        ("termsId", TID),
        ("version", 1),
        ("parties", [A, B]),
        ("previousTermsHash", None),
        ("termsHash", base_hash),
        ("note", "x"),
        ("foo", 1),
    ]:
        slug = re.sub(r"([a-z])([A-Z])", r"\1-\2", key).lower()
        input_case(f"reject-{slug}", f"{S_INPUT}, M1-21: TermsInput refuses `{key}` (core-filled, or an unknown key)", {**ti, key: value}, False)
    for slug, path, value, why in [
        ("rlo-subject", ["subject"], "Spec \u202ev2", "an RLO in subject"),
        ("zwsp-description", ["deliverables", 0, "description"], "Mile\u200bstone", "a zero-width space in a deliverable"),
        ("cyrillic-currency", ["price", "currency"], "\u0415UR", "Cyrillic \u0415UR"),
        ("amount-7-decimals", ["price", "amount"], "1500.0000001", "1500.0000001"),
        ("amount-zero", ["price", "amount"], "0", "amount 0"),
        ("due-offset", ["deadlines", 0, "due"], "2026-11-30T18:00:00+01:00", "a due date with an offset"),
        ("plaintext-sha256-uppercase", ["deliverables", 1, "plaintextSha256"], DIGEST.upper(), "upper-case hex"),
        ("by-address", ["deliverables", 0, "by"], B, "by as an agent ID (only me | them)"),
        ("by-other", ["deliverables", 0, "by"], "us", "by outside me | them"),
        ("payer-address", ["price", "payer"], A, "payer as an agent ID (only me | them)"),
        ("payer-capitalised", ["price", "payer"], "Me", "payer \"Me\""),
        ("deliverables-empty", ["deliverables"], [], "no deliverables (at least one)"),
        ("unknown-deliverable-key", ["deliverables", 0, "deadline"], "x", "an unknown deliverable key"),
        ("unknown-price-key", ["price", "usd"], "1", "an unknown price key"),
        ("duplicate-id", ["deliverables", 1, "id"], "d1", "duplicate deliverable ids"),
        ("unknown-ref", ["deadlines", 0, "ref"], "d9", "a deadline ref that names no deliverable"),
        ("valid-until-integer", ["validUntil"], VALID_UNTIL, "validUntil as unix seconds (TermsInput takes a string)"),
        ("subject-missing", ["subject"], None, "no subject"),
    ]:
        q = ""
        if slug == "unknown-ref":
            q = oq(9, "ref must name a deliverable")
        delete = slug == "subject-missing"
        input_case(f"reject-{slug}", q + f"{S_INPUT}, {S_CANON}: {why}", with_path(ti, path, value, delete=delete), False)

    # Mapping to terms (all cases depend on Q3, Q4 and Q12).
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
    mapped = map_case(
        "full",
        oq(4, "parties = [own agent, contact]") + oq(12, "strict Z form converted to unix seconds") + f"{S_INPUT}: me/them mapped to agent IDs in by and payer, core-filled fields from the context",
        ti,
        ctx_a,
    )
    if mapped != base:
        v.fail("the full TermsInput must map to the base terms")
    map_case(
        "defaults",
        oq(3, "plaintextSha256 null, deadlines [], no price") + oq(12, "validUntil = now + 604800") + f"{S_INPUT}: ids default to d1, d2",
        {"subject": "Logo files", "deliverables": [{"description": "SVG logo", "by": "them"}, {"description": "PNG exports", "by": "them"}]},
        ctx_a,
    )
    map_case(
        "counter-by-b",
        oq(4, "parties = [own agent, contact]") + f"{S_INPUT}: B's core counters version 1 with version 2; me = B",
        with_path(ti, ["price", "amount"], "1400.00"),
        {"me": B, "them": A, "termsId": TID, "version": 2, "previousTermsHash": base_hash, "now": NOW},
    )

    # 7. The negotiation chain. Envelopes between A and B, seen from one core.
    def chain_case(case_id, source, me, log, incoming, outcome):
        got, version, h = chain_receive(me, log, incoming)
        if got != outcome:
            v.fail(f"chain {case_id}: the reference model says {got}")
        add(
            f"chain-{case_id}",
            source,
            {"op": "chainReceive", "self": me, "now": NOW, "log": log, "incoming": incoming},
            {"outcome": outcome, "newestVersion": str(version), "newestTermsHash": h or "null"},
        )

    def offer(label, sender, version, prev, tid=TID, parties=(A, B), **over):
        to = parties[1] if sender == parties[0] else parties[0]
        t = base_terms(termsId=tid, version=version, previousTermsHash=prev, parties=list(parties), **over)
        if sender == C or to == C:
            t["deliverables"] = [dict(d, by=parties[i % 2]) for i, d in enumerate(t["deliverables"])]
            t["price"] = dict(t["price"], payer=parties[0])
        return env(label, sender, to, "offer", t)

    def h_of(e):
        return e["body"]["termsHash"]

    def answer(label, sender, type_, offer_env, terms=None, note=None):
        t = terms if terms is not None else offer_env["body"]["terms"]
        return env(label, sender, offer_env["from"], type_, t, reply_to=offer_env["id"], note=note)

    a1 = offer("a1", A, 1, None)
    b2 = offer("b2", B, 2, h_of(a1), subject="Spec v2 \u2013 milestone 3 (counter)")
    a3 = offer("a3", A, 3, h_of(b2), subject="Spec v2 \u2013 milestone 3 (final)")

    chain_case("new-negotiation", f"{S_CHAIN}: a first offer, version 1 with previousTermsHash null", B, [], a1, "valid")
    chain_case("counter", f"{S_CHAIN}: version = newest + 1 and previousTermsHash = newest hash", A, [sent(a1)], b2, "valid")
    chain_case("third-version", f"{S_CHAIN}: version 3 on version 2", B, [received(a1), sent(b2)], a3, "valid")
    chain_case("new-not-version-1", f"{S_CHAIN}: a new negotiation that starts at version 2", B, [], offer("x2", A, 2, None), "refused")
    chain_case("new-with-pointer", oq(11, "pointer consistency is a chain check") + f"{S_CHAIN}: version 1 with a previousTermsHash", B, [], offer("x1p", A, 1, DIGEST), "refused")
    chain_case("version-gap", f"{S_CHAIN}: a version gap (version 3 on newest 1)", A, [sent(a1)], offer("b3gap", B, 3, h_of(a1)), "refused")
    chain_case("pointer-to-older", f"{S_CHAIN}: version 3 whose previousTermsHash names version 1, not the newest (2)", B, [received(a1), sent(b2)], offer("a3old", A, 3, h_of(a1)), "refused")
    chain_case("pointer-unknown", f"{S_CHAIN}: version 2 whose previousTermsHash names no stored version", A, [sent(a1)], offer("b2x", B, 2, DIGEST), "refused")
    chain_case("parties-swapped-same-key", f"{S_CHAIN}: the key holds the unordered pair, so parties [B, A] continue A's [A, B] negotiation", A, [sent(a1)], offer("b2s", B, 2, h_of(a1), parties=(B, A)), "valid")

    # The same termsId from another pair (A-C at version 3) does not affect A-B.
    c1 = offer("c1", C, 1, None, parties=(C, A))
    a2c = offer("a2c", A, 2, h_of(c1), parties=(C, A))
    c3 = offer("c3", C, 3, h_of(a2c), parties=(C, A))
    log_ac = [received(c1), sent(a2c), received(c3)]
    chain_case("same-terms-id-other-pair", f"{S_CHAIN}: the same termsId from another pair (A-C, version 3) does not affect A-B; B's version 1 is valid", A, log_ac, offer("b1", B, 1, None, parties=(B, A)), "valid")
    chain_case("same-terms-id-other-pair-continued", f"{S_CHAIN}: B cannot continue the A-C chain: version 4 on A-C's version 3 is refused for A-B", A, log_ac, offer("b4", B, 4, h_of(c3), parties=(B, A)), "refused")
    chain_case("not-a-party", f"{S_CHAIN}, 04 §3.4: an offer from B whose parties are A and C", A, [], offer("bac", B, 1, None, parties=(A, C)), "refused")

    # Rule 1: a second, different envelope from the same sender for the same version.
    b2_again = env("b2-again", B, A, "offer", b2["body"]["terms"])
    chain_case("same-sender-same-terms", f"{S_CHAIN} rule 1: the same terms re-sent in a new envelope; the first one seen wins", A, [sent(a1), received(b2)], b2_again, "refused")
    chain_case("same-sender-other-terms", f"{S_CHAIN} rule 1: a second version 2 from B with other terms", A, [sent(a1), received(b2)], offer("b2-other", B, 2, h_of(a1), subject="other"), "refused")
    chain_case("same-sender-first-refused-replay", f"{S_CHAIN} rule 1: a third version-2 envelope after a refused second one; still the first wins", A, [sent(a1), received(b2), received(b2_again)], offer("b2-third", B, 2, h_of(a1), subject="third"), "refused")

    # Rule 2: a version is locked once an accept for it was sent or received.
    acc_b2 = answer("acc-b2", A, "accept", b2)
    chain_case("fork-after-accept-sent", f"{S_CHAIN} rule 2: A accepted B's version 2; B's other version-2 envelope is refused", A, [sent(a1), received(b2), sent(acc_b2)], offer("b2-fork", B, 2, h_of(a1), subject="fork"), "refused")
    a2 = offer("a2", A, 2, h_of(a1), subject="Spec v2 \u2013 milestone 3 (revised)")
    acc_a2 = answer("acc-a2", B, "accept", a2)
    chain_case("fork-after-accept-received", f"{S_CHAIN} rule 2: B accepted A's version 2; a version-2 counter from B is refused, not a conflict, and version 2 stays newest", A, [sent(a1), sent(a2), received(acc_a2)], offer("b2-late", B, 2, h_of(a1), subject="late counter"), "refused")
    chain_case("second-accept", f"{S_CHAIN} rule 2: a second accept envelope for the accepted version", A, [sent(a1), sent(a2), received(acc_a2)], answer("acc-a2-again", B, "accept", a2), "refused")
    chain_case("offer-after-accept", oq(15, "only the accepted version is locked") + f"{S_CHAIN}: version 3 after version 2 was accepted", A, [sent(a1), sent(a2), received(acc_a2)], offer("b3-after", B, 3, h_of(a2)), "valid")

    # Rule 3: concurrent counters from both sides for the same version.
    a2_rev = offer("a2-rev", A, 2, h_of(a1), subject="A's revision")
    b2_ctr = offer("b2-ctr", B, 2, h_of(a1), subject="B's counter")
    chain_case("concurrent-counters-a", f"{S_CHAIN} rule 3: A revised version 1 to 2 while B countered it with 2; a conflict, version 1 stays newest", A, [sent(a1), sent(a2_rev)], b2_ctr, "conflict")
    chain_case("concurrent-counters-b", f"{S_CHAIN} rule 3: the same conflict seen by B; both cores detect it the same way", B, [received(a1), sent(b2_ctr)], a2_rev, "conflict")
    chain_case(
        "after-conflict-resend",
        oq(17, "rule 3 allows the conflicted version again from either side") + f"{S_CHAIN} rule 3: after the conflict B sends version 2 again on version 1",
        A,
        [sent(a1), sent(a2_rev), received(b2_ctr)],
        offer("b2-after", B, 2, h_of(a1), subject="B again"),
        "valid",
    )
    chain_case("conflicted-not-a-base", f"{S_CHAIN} rule 3: the conflicting envelopes are not acceptable, so version 3 on B's conflicted version 2 is refused", A, [sent(a1), sent(a2_rev), received(b2_ctr)], offer("b3-on-conflict", B, 3, h_of(b2_ctr)), "refused")

    # Accept and reject on receipt.
    chain_case("accept-matching", f"{S_CHAIN}, 04 §3.4: B accepts A's newest version with its termsHash", A, [sent(a1), sent(a2)], acc_a2, "valid")
    chain_case(
        "accept-hash-mismatch",
        oq(13, "the accept names its offer by replyTo") + "M1-21 Acceptance: an accept whose termsHash does not match the offer it answers (it quotes version 1's terms) is refused",
        A,
        [sent(a1), sent(a2)],
        answer("acc-mismatch", B, "accept", a2, terms=a1["body"]["terms"]),
        "refused",
    )
    chain_case(
        "accept-own-offer",
        oq(13, "replyTo names the answered offer") + f"{S_CHAIN}: an accept that answers B's own offer",
        A,
        [sent(a1), received(b2)],
        env("acc-own", B, A, "accept", b2["body"]["terms"], reply_to=b2["id"]),
        "refused",
    )
    chain_case(
        "accept-superseded-own-offer",
        oq(13, "stored as valid; the approval card warns that it is superseded") + "06 §2.2a path (b): B accepts A's version 1 after A sent version 2",
        A,
        [sent(a1), sent(a2)],
        answer("acc-a1", B, "accept", a1),
        "valid",
    )
    chain_case("reject-message", f"{S_CHAIN}, 06 §2.2a: a plain reject is stored and is not final; version 2 stays newest", A, [sent(a1), sent(a2)], answer("rej-a2", B, "reject", a2, note="Too expensive."), "valid")

    # A sending core sets version and previousTermsHash from its own store.
    def next_case(case_id, source, me, contact, tid, log, version, prev):
        got_v, got_h = next_offer(me, contact, tid, log)
        if (got_v, got_h) != (version, prev):
            v.fail(f"next {case_id}: the reference model says {got_v}, {got_h}")
        add(
            f"next-{case_id}",
            source,
            {"op": "nextOffer", "self": me, "contact": contact, "termsId": tid, "log": log},
            {"version": str(version), "previousTermsHash": prev or "null"},
        )

    next_case("new", f"{S_CHAIN}: a new negotiation is version 1 with previousTermsHash null", A, B, TID, [], 1, None)
    next_case("after-counter", f"{S_CHAIN}: newest + 1 and the newest termsHash", A, B, TID, [sent(a1), received(b2)], 3, h_of(b2))
    next_case("ignores-pointer", f"{S_CHAIN}: computed from the own store, never from a refused counterparty pointer", A, B, TID, [sent(a1), received(offer("b3gap", B, 3, h_of(a1)))], 2, h_of(a1))
    next_case("other-pair", f"{S_CHAIN}: the A-C chain of the same termsId does not count for A-B", A, B, TID, log_ac, 1, None)
    next_case("after-conflict", f"{S_CHAIN} rule 3: after a conflict the previous version stays newest, so the next offer is version 2 on version 1", A, B, TID, [sent(a1), sent(a2_rev), received(b2_ctr)], 2, h_of(a1))

    # Sending an accept (04 §3.4): the newest offer received from that contact, within validUntil.
    def accept_case(case_id, source, me, now, log, answers, allowed):
        got = send_accept(me, now, log, answers)
        if (got is not None) != allowed:
            v.fail(f"send-accept {case_id}: the reference model says {got}")
        expected = {"outcome": "allowed", "termsHash": got} if allowed else {"outcome": "refused"}
        add(f"send-accept-{case_id}", source, {"op": "sendAccept", "self": me, "now": now, "log": log, "answers": answers}, expected)

    log_b2 = [sent(a1), received(b2)]
    accept_case("newest", f"{S_ACCEPT}: B's version 2 is the newest offer received from B", A, NOW, log_b2, b2["id"], True)
    accept_case("at-valid-until", oq(14, "within validUntil at now == validUntil") + f"{S_ACCEPT}: now equals validUntil", A, VALID_UNTIL, log_b2, b2["id"], True)
    accept_case("expired", f"{S_ACCEPT}: now is after validUntil (TERMS_EXPIRED)", A, VALID_UNTIL + 1, log_b2, b2["id"], False)
    accept_case("superseded", f"{S_ACCEPT}: A's version 3 superseded B's version 2 (TERMS_SUPERSEDED)", A, NOW, log_b2 + [sent(a3)], b2["id"], False)
    accept_case("older-version", f"{S_ACCEPT}: B answers A's version 1 after A's version 3 arrived", B, NOW, [received(a1), sent(b2), received(a3)], a1["id"], False)
    accept_case("own-offer", f"{S_ACCEPT}: an offer A sent itself", A, NOW, log_b2, a1["id"], False)
    b3gap = offer("b3gap", B, 3, h_of(a1))
    accept_case("refused-offer", f"{S_ACCEPT}: an offer the store refused (a version gap)", A, NOW, [sent(a1), received(b3gap)], b3gap["id"], False)
    accept_case("conflicted", f"{S_ACCEPT}, {S_CHAIN} rule 3: B's conflicting version 2 is not acceptable", A, NOW, [sent(a1), sent(a2_rev), received(b2_ctr)], b2_ctr["id"], False)
    accept_case("locked", f"{S_ACCEPT}, {S_CHAIN} rule 2: version 2 is already accepted", A, NOW, log_b2 + [sent(acc_b2)], b2["id"], False)
    accept_case("unknown-envelope", f"{S_ACCEPT}: no stored offer with that id", A, NOW, log_b2, v.b64u(v.det("terms/envelope/unknown", 16)), False)
    return cases


S = v.STRING
SCHEMA = v.case_schema(
    SUITE,
    "04 §3.4 (D-32, D-55), 06 §2.2a: terms, termsHash, the offer/accept/reject body, TermsInput and its "
    "mapping, and the negotiation chain. Cases whose source starts with OPEN QUESTION depend on a "
    "reading the spec leaves open (see tools/vectors/generate_terms.py).",
    {
        "parseTerms": ({"terms": v.ANY}, [{"outcome": {"const": "accept"}, "termsHash": v.hexn(32)}, v.REJECT]),
        "parseTermsJson": ({"json": S}, [{"outcome": {"const": "accept"}, "termsHash": v.hexn(32)}, v.REJECT]),
        "parseTermsBody": ({"type": S, "body": v.ANY}, [{"outcome": {"const": "accept"}, "termsHash": v.hexn(32)}, v.REJECT]),
        "parseTermsInput": ({"termsInput": v.ANY}, [v.ACCEPT, v.REJECT]),
        "mapTermsInput": ({"termsInput": v.OBJECT, "context": v.OBJECT}, [{"termsHash": v.hexn(32), "termsJcs": S}]),
        "chainReceive": (
            {"self": v.ADDRESS, "now": v.INTEGER, "log": v.ARRAY, "incoming": v.OBJECT},
            [{"outcome": {"enum": ["valid", "refused", "conflict"]}, "newestVersion": {"type": "string", "pattern": "^(0|[1-9][0-9]*)$"}, "newestTermsHash": {"type": "string", "pattern": "^([0-9a-f]{64}|null)$"}}],
        ),
        "nextOffer": (
            {"self": v.ADDRESS, "contact": v.ADDRESS, "termsId": v.B64U, "log": v.ARRAY},
            [{"version": {"type": "string", "pattern": "^[1-9][0-9]*$"}, "previousTermsHash": {"type": "string", "pattern": "^([0-9a-f]{64}|null)$"}}],
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
