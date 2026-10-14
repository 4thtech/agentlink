#!/usr/bin/env python3
"""Independent generator for the `safety-code` suite: the pairing safety code (M1-1h; G-28).

The signed H/K recomputation cases (04 §3.6.1 steps 1-5) are built here too but written to their own
suite, `safety-code-recompute`, by generate_safety_code_recompute.py: they need the envelope helpers
of M1-1c, while the cases of this suite need only M1-1f (IR-M1-1f-1 M-1). The cases themselves are
unchanged.

04 §3.6.1, exactly:
  codeCommit = taggedHash("agentlink/safety-commit/v1", inviteId || nonceA)
  T          = sha256(JCS(cardA)) || sha256(JCS(cardB)) || inviteId || nonceA || nonceB   (144 bytes)
  digest     = taggedHash("agentlink/safety-code/v1", T)                                  (pairingDigest)
  code       = u64be(digest[0..8]) mod 10^12, shown as "dddd dddd dddd" with leading zeros
cardA is the inviter's card (the invite, and the `handshake-ack` K), cardB the invitee's (the
`handshake` H), each in the card JSON form (04 §2.4); inviteId and the nonces are raw bytes and
base64url in JSON. JCS is `rfc8785`, hashes are hashlib, cards and their signatures come from the
`eip712` generator, envelopes from the `aead-envelope` and `hpke` generators.

Cases: the commitment; a reveal that does not open it; T, digest, the 64-bit integer and the code;
codes with leading zeros; an integer in the top, biased part of the 2^64 range (at or above
10^12 * floor(2^64 / 10^12)); a role swap; the same input under the two labels; and a full signed
H and K pair recomputed per 04 §3.6.1 steps 1-5, plus one failing pair per step 1-4. The surface's
inputs are its own agent ID, the contact's current card, and H and K as envelopes with their CEKs
(the surface's own unwrap is covered by the `hpke` suite). Keys and nonces are synthetic.

Usage: python3 -I tools/vectors/generate_safety_code.py --check [FILE] | --write
"""

import copy
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import generate_aead_envelope as env  # noqa: E402
import generate_eip712 as eip712  # noqa: E402
import generate_hpke as hpke  # noqa: E402
import generate_pairing as pairing  # noqa: E402
import vectorlib as v  # noqa: E402

SUITE = "safety-code"
VERSION = 1
SPEC = "04 §3.6.1"
COMMIT_TAG = "agentlink/safety-commit/v1"
CODE_TAG = "agentlink/safety-code/v1"
TOP = 10**12 * (2**64 // 10**12)  # integers at or above this make the biased codes

# The smallest i for which nonceB = det("safety-code/nonce-b/<lead|top>/<i>") gives a code with four
# leading zeros, and an integer in the biased top of the range. Searching takes minutes (the top
# region is about 5.5e-8 of the range), so the indices are fixed here and re-checked on every run.
SEARCH = {"leading-4-zeros": 13053, "top-of-range": 358509200}


def commit(invite_id, nonce_a):
    return v.tagged_hash(COMMIT_TAG, invite_id + nonce_a)


def transcript(card_a, card_b, invite_id, nonce_a, nonce_b):
    t = v.sha256(v.jcs(card_a)) + v.sha256(v.jcs(card_b)) + invite_id + nonce_a + nonce_b
    if len(t) != 144:
        v.fail("T is not 144 bytes")
    return t


def code_of(t):
    digest = v.tagged_hash(CODE_TAG, t)
    n = int.from_bytes(digest[:8], "big")
    digits = f"{n % 10**12:012d}"
    return digest, n, f"{digits[0:4]} {digits[4:8]} {digits[8:12]}"


def party(label, name):
    card = eip712.make_card(label, name, ["wss://relay.example.com"], 1760000000, 1791536000, 0)
    owner_evm = v.det(f"eip712/{label}/owner/evm", 32)
    agent_evm = v.det(f"eip712/{label}/agent/evm", 32)
    digest = eip712.card_digest(card)
    return {
        "card": card,
        "cardSig": eip712.card_sig(owner_evm, digest),
        "cardAgentSig": eip712.card_sig(agent_evm, digest),
        "nostr": v.det(f"eip712/{label}/agent/nostr", 32),
        "ownerNostr": v.det(f"eip712/{label}/owner/nostr", 32),
        "enc": [v.det(f"eip712/{label}/agent/enc", 32), v.det(f"eip712/{label}/owner/enc", 32)],
    }


def envelope(sender_nostr, recipients_enc, body_type, body, label):
    """A signed envelope v1 carrying `body` (04 §3.1, §3.3: wraps with ephemeral keys derived from
    the CEK, payload under encKey with the key commitment kc; G-46, D-66), deterministic."""
    cek = v.det(f"safety-code/{label}/cek", 32)
    env_id = v.det(f"safety-code/{label}/id", 16)
    recipients = []
    for public in recipients_enc:
        enc, wk = hpke.wrap_cek(public, env_id, cek)
        recipients.append({"kid": v.b64u(v.sha256(public)[:16]), "enc": v.b64u(enc), "wk": v.b64u(wk)})
    e = {
        "v": 1,
        "id": v.b64u(env_id),
        "thread": v.b64u(v.det(f"safety-code/{label}/thread", 16)),
        "from": v.hx(v.xonly_public_key(sender_nostr)),
        "createdAt": 1760000100,
        "recipients": recipients,
    }
    payload = v.jcs({"type": body_type, "body": body, "replyTo": None, "files": []})
    iv = v.det(f"safety-code/{label}/iv", 12)
    e["aead"] = env.encrypt_payload(e, cek, iv, payload)
    e["sig"] = v.hx(env.sign(e, sender_nostr, v.det(f"safety-code/{label}/aux", 32)))
    return {"envelope": e, "cek": v.hx(cek)}


def open_body(item):
    e = item["envelope"]
    if not env.verify(e):
        raise ValueError("envelope signature")
    payload = env.decrypt(e, bytes.fromhex(item["cek"]))
    if payload is None:
        raise ValueError("payload")
    import json

    return json.loads(payload)["body"]


def recompute(self_id, contact_card, h_item, k_item):
    """04 §3.6.1 steps 1-5. Returns (digest, shown) or raises ValueError."""
    h, k = open_body(h_item), open_body(k_item)
    hc, kc = h["card"], k["card"]
    # Step 1.
    if bytes.fromhex(h_item["envelope"]["from"]) != bytes.fromhex(hc["agentNostr"][2:]):
        raise ValueError("H from")
    if not eip712.verify_card_sig(hc, h["cardSig"]) or not eip712.verify_card_sig(hc, h["cardAgentSig"], "agentEvm"):
        raise ValueError("H card")
    # Step 2.
    if bytes.fromhex(k_item["envelope"]["from"]) != bytes.fromhex(kc["agentNostr"][2:]):
        raise ValueError("K from")
    if not eip712.verify_card_sig(kc, k["cardSig"]):
        raise ValueError("K card")
    if v.sha256(v.jcs(kc)).hex() != h["inviterCardHash"]:
        raise ValueError("K card is not the invite card")
    if k["handshakeHash"] != "0x" + env.envelope_hash(h_item["envelope"]).hex() or k["inviteId"] != h["inviteId"]:
        raise ValueError("K does not answer H")
    # Step 3.
    invite_id = v.unb64u(h["inviteId"])
    if commit(invite_id, v.unb64u(k["codeReveal"])) != v.unb64u(h["codeCommit"]):
        raise ValueError("reveal does not open the commitment")
    # Step 4.
    if self_id == kc["agentEvm"]:
        other = hc
    elif self_id == hc["agentEvm"]:
        other = kc
    else:
        raise ValueError("neither card is this agent's")
    for field in ("agentEvm", "ownerEvm", "ownerNostr", "ownerEnc"):
        if other[field] != contact_card[field]:
            raise ValueError("the contact's current card differs")
    # Step 5.
    t = transcript(kc, hc, invite_id, v.unb64u(k["codeReveal"]), v.unb64u(h["codeNonce"]))
    digest, _, shown = code_of(t)
    return digest, shown


def build_all():
    a, b = party("safety-a", "Inviter A"), party("safety-b", "Invitee B")
    card_a, card_b = a["card"], b["card"]
    invite_id = v.det("safety-code/invite-id", 16)
    nonce_a = v.det("safety-code/nonce-a", 32)
    nonce_b = v.det("safety-code/nonce-b", 32)
    cc = commit(invite_id, nonce_a)
    cases = [
        v.case("commit", f"{SPEC} codeCommit = taggedHash(safety-commit, inviteId || nonceA)", {"op": "commit", "inviteId": v.b64u(invite_id), "nonceA": v.b64u(nonce_a)}, {"codeCommit": v.b64u(cc)}),
        v.case("reveal-opens", f"{SPEC}: codeReveal = nonceA opens codeCommit", {"op": "checkReveal", "inviteId": v.b64u(invite_id), "codeCommit": v.b64u(cc), "codeReveal": v.b64u(nonce_a)}, {"outcome": "accept"}),
        v.case("reveal-reject-other-nonce", f"{SPEC}: a codeReveal that does not open codeCommit is refused", {"op": "checkReveal", "inviteId": v.b64u(invite_id), "codeCommit": v.b64u(cc), "codeReveal": v.b64u(nonce_b)}, {"outcome": "reject"}),
        v.case("reveal-reject-other-invite", f"{SPEC}: the right nonce under another inviteId does not open it", {"op": "checkReveal", "inviteId": v.b64u(v.det("safety-code/other-invite", 16)), "codeCommit": v.b64u(cc), "codeReveal": v.b64u(nonce_a)}, {"outcome": "reject"}),
    ]

    def code_case(case_id, why, ca, cb, nb):
        t = transcript(ca, cb, invite_id, nonce_a, nb)
        digest, n, shown = code_of(t)
        cases.append(
            v.case(
                case_id,
                f"{SPEC}: {why}",
                {"op": "code", "cardA": ca, "cardB": cb, "inviteId": v.b64u(invite_id), "nonceA": v.b64u(nonce_a), "nonceB": v.b64u(nb)},
                {"transcript": t.hex(), "pairingDigest": digest.hex(), "integer": str(n), "code": shown},
            )
        )
        return n, shown

    _, base_code = code_case("code", "T, digest, 64-bit integer and code", card_a, card_b, nonce_b)
    _, swapped = code_case("code-role-swap", "the roles swapped (invitee's card first) give a different code", card_b, card_a, nonce_b)
    if swapped == base_code:
        v.fail("role swap gives the same code")
    lead = v.det(f"safety-code/nonce-b/lead/{SEARCH['leading-4-zeros']}", 32)
    n, shown = code_case("code-leading-zeros", "a code with leading zeros keeps all 12 digits", card_a, card_b, lead)
    if not shown.startswith("0000"):
        v.fail("the leading-zero search index is stale")
    top = v.det(f"safety-code/nonce-b/top/{SEARCH['top-of-range']}", 32)
    n, _ = code_case("code-top-of-range", "an integer in the biased top of the 2^64 range (>= 10^12 * floor(2^64 / 10^12))", card_a, card_b, top)
    if n < TOP:
        v.fail("the top-of-range search index is stale")

    t = transcript(card_a, card_b, invite_id, nonce_a, nonce_b)
    if v.tagged_hash(COMMIT_TAG, t) == v.tagged_hash(CODE_TAG, t):
        v.fail("labels collide")
    cases.append(v.case("labels-differ", f"{SPEC}: the same input under the commit and the code labels", {"op": "labels", "input": t.hex()}, {"safetyCommit": v.hx(v.tagged_hash(COMMIT_TAG, t)), "safetyCode": v.hx(v.tagged_hash(CODE_TAG, t))}))

    # A full signed handshake H (B -> A) and handshake-ack K (A -> B).
    secret = v.det("safety-code/invite-secret", 32)
    recipients = [a["enc"][0], a["enc"][1], b["enc"][1], b["enc"][0]]  # 04 §3.2 / §3.6 roles
    recipients = [v.x25519_public_key(x) for x in recipients]

    def make_h(**overrides):
        body = {
            "inviteId": v.b64u(invite_id),
            "card": card_b,
            "cardSig": b["cardSig"],
            "cardAgentSig": b["cardAgentSig"],
            "name": "Invitee B",
            "relays": ["wss://relay.example.com"],
            "proof": v.b64u(pairing.proof_of(secret, invite_id, card_b)),
            "codeNonce": v.b64u(nonce_b),
            "codeCommit": v.b64u(cc),
            "inviterCardHash": v.sha256(v.jcs(card_a)).hex(),
        }
        signer = overrides.pop("signer", b["nostr"])
        body.update(overrides)
        return envelope(signer, recipients, "handshake", body, "h-" + "-".join(sorted(overrides)) + ("-signer" if signer is not b["nostr"] else ""))

    def make_k(h_item, **overrides):
        body = {
            "inviteId": v.b64u(invite_id),
            "handshakeId": h_item["envelope"]["id"],
            "handshakeHash": "0x" + env.envelope_hash(h_item["envelope"]).hex(),
            "codeReveal": v.b64u(nonce_a),
            "card": card_a,
            "cardSig": a["cardSig"],
        }
        signer = overrides.pop("signer", a["nostr"])
        body.update(overrides)
        return envelope(signer, recipients, "handshake-ack", body, "k-" + "-".join(sorted(overrides)) + ("-signer" if signer is not a["nostr"] else ""))

    H = make_h()
    K = make_k(H)
    expected_digest, expected_code = code_of(transcript(card_a, card_b, invite_id, nonce_a, nonce_b))[0], base_code
    for case_id, self_id, contact in [("recompute-inviter", card_a["agentEvm"], card_b), ("recompute-invitee", card_b["agentEvm"], card_a)]:
        digest, shown = recompute(self_id, contact, H, K)
        if digest != expected_digest or shown != expected_code:
            v.fail(f"{case_id}: recomputation differs")
        cases.append(
            v.case(
                case_id,
                f"{SPEC} steps 1-5: both sides recompute the same code from the signed H and K",
                {"op": "recompute", "self": self_id, "contactCard": contact, "handshake": H, "ack": K},
                {"pairingDigest": digest.hex(), "code": shown},
            )
        )

    def tampered_sig(item):
        out = copy.deepcopy(item)
        sig = out["envelope"]["sig"]
        out["envelope"]["sig"] = sig[:-1] + ("0" if sig[-1] != "0" else "1")
        return out

    other_card = party("safety-c", "Someone else")
    H_other_signer = make_h(signer=other_card["nostr"])
    H_owner_as_agent_sig = make_h(cardAgentSig=b["cardSig"])
    K_for_other_card = make_k(H, card=other_card["card"], cardSig=other_card["cardSig"], signer=other_card["nostr"])
    K_wrong_hash = make_k(H, handshakeHash="0x" + v.sha256(b"not H").hex())
    K_wrong_invite = make_k(H, inviteId=v.b64u(v.det("safety-code/other-invite", 16)))
    K_bad_reveal = make_k(H, codeReveal=v.b64u(nonce_b))
    failing = [
        ("step-1-h-signature", "H's envelope signature is invalid", card_a["agentEvm"], card_b, tampered_sig(H), K),
        ("step-1-h-from", "H is signed by a key other than H.card.agentNostr", card_a["agentEvm"], card_b, H_other_signer, make_k(H_other_signer)),
        ("step-1-h-card-agent-sig", "H.card's cardAgentSig is the owner's signature", card_a["agentEvm"], card_b, H_owner_as_agent_sig, make_k(H_owner_as_agent_sig)),
        ("step-2-k-signature", "K's envelope signature is invalid", card_b["agentEvm"], card_a, H, tampered_sig(K)),
        ("step-2-k-not-invite-card", "K carries a card other than the invite card (inviterCardHash)", card_b["agentEvm"], card_a, H, K_for_other_card),
        ("step-2-k-handshake-hash", "K's handshakeHash is not H's envelopeHash", card_b["agentEvm"], card_a, H, K_wrong_hash),
        ("step-2-k-invite-id", "K's inviteId differs from H's", card_b["agentEvm"], card_a, H, K_wrong_invite),
        ("step-3-reveal", "K's codeReveal does not open H's codeCommit", card_b["agentEvm"], card_a, H, K_bad_reveal),
        ("step-4-not-own-agent", "neither card is the surface's own agent", other_card["card"]["agentEvm"], card_a, H, K),
        ("step-4-contact-card", "the contact's current card has other owner keys", card_a["agentEvm"], {**card_b, "ownerNostr": other_card["card"]["ownerNostr"]}, H, K),
    ]
    for case_id, why, self_id, contact, h_item, k_item in failing:
        try:
            recompute(self_id, contact, h_item, k_item)
            v.fail(f"{case_id} recomputes")
        except ValueError:
            pass
        cases.append(
            v.case(
                f"recompute-reject-{case_id}",
                f"{SPEC} step {case_id.split('-')[1]}: {why}; no code is shown",
                {"op": "recompute", "self": self_id, "contactCard": contact, "handshake": h_item, "ack": k_item},
                {"outcome": "reject"},
            )
        )
    return cases


ITEM = {
    "type": "object",
    "additionalProperties": False,
    "required": ["envelope", "cek"],
    "properties": {"envelope": v.OBJECT, "cek": v.hexn(32)},
}
SCHEMA = v.case_schema(
    SUITE,
    "04 §3.6.1 safety code. `commit`: codeCommit. `checkReveal`: whether codeReveal opens codeCommit. "
    "`code`: T, pairingDigest, the 64-bit integer (decimal) and the shown code. `labels`: the two "
    "tagged hashes of the same input. The steps 1-5 recomputation is the `safety-code-recompute` suite.",
    {
        "commit": ({"inviteId": v.B64U, "nonceA": v.B64U}, [{"codeCommit": v.B64U}]),
        "checkReveal": ({"inviteId": v.B64U, "codeCommit": v.B64U, "codeReveal": v.B64U}, [v.ACCEPT, v.REJECT]),
        "code": (
            {"cardA": v.OBJECT, "cardB": v.OBJECT, "inviteId": v.B64U, "nonceA": v.B64U, "nonceB": v.B64U},
            [{"transcript": v.HEX, "pairingDigest": v.hexn(32), "integer": {"type": "string", "pattern": "^(0|[1-9][0-9]*)$"}, "code": {"type": "string", "pattern": "^[0-9]{4} [0-9]{4} [0-9]{4}$"}}],
        ),
        "labels": ({"input": v.HEX}, [{"safetyCommit": v.hexn(32), "safetyCode": v.hexn(32)}]),
    },
)

RECOMPUTE_SCHEMA_OP = (
    {"self": v.ADDRESS, "contactCard": v.OBJECT, "handshake": ITEM, "ack": ITEM},
    [{"pairingDigest": v.hexn(32), "code": {"type": "string", "pattern": "^[0-9]{4} [0-9]{4} [0-9]{4}$"}}, v.REJECT],
)


def build():
    """The cases that need only M1-1f: commit, checkReveal, code and labels."""
    return [c for c in build_all() if c["input"]["op"] != "recompute"]


def build_recompute():
    """The 04 §3.6.1 steps 1-5 cases (suite `safety-code-recompute`)."""
    return [c for c in build_all() if c["input"]["op"] == "recompute"]


if __name__ == "__main__":
    v.main(
        suite=SUITE,
        version=VERSION,
        script="tools/vectors/generate_safety_code.py",
        libraries=["cryptography", "coincurve", "pycryptodome", "pyhpke", "rfc8785"],
        build=build,
        schema=SCHEMA,
        doc=__doc__,
    )
