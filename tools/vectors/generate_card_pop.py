#!/usr/bin/env python3
"""Independent generator for the `card-pop` suite: the agent card's proof of possession (M1-1h-f).

04 §2.9 and 07 §8 (D-102, M1-4d-d): two signatures over one AgentCard show that both of the agent's
keys named in it signed that card.
- `cardAgentSig`: the agent EVM key's EIP-712 signature over the card under the chain-agnostic
  AgentCard domain, 0x + 130 lowercase hex under the canonical ECDSA rule (04 §2.4.1). The EIP-712
  card digest and deterministic ECDSA (RFC 6979, low s, libsecp256k1 via coincurve) come from
  generate_eip712.py, which reproduces the official EIP-712 example before it writes anything.
- `cardPop`: BIP-340 (libsecp256k1 `schnorrsig`, via coincurve) by the card's `agentNostr` over
  taggedHash("agentlink/card-pop/v1", sha256(JCS(card))), bare 128 lowercase hex. JCS is RFC 8785
  (`rfc8785`), SHA-256 is CPython `hashlib`.

Ops:
- `cardPopMessage`: the tag, the card hash sha256(JCS(card)) (04 §3.6) and the 32-byte message.
- `signCardPop`: the deterministic cardPop for a card, the card's agentNostr secret key and a
  fixed auxRand; refused for a card that does not parse or a key that is not the card's agentNostr.
- `verifyCardPop`: accept only a cardPop by this card's agentNostr over this card under this tag.
- `verifyCardPossession`: accept only when cardAgentSig recovers agentEvm and cardPop verifies, both
  over this exact card; either one missing is a reject.
- `signerShape` (07 §8 `signer`) and `cardUpdateShape` (04 §3.4.1 `card-update` body): cardAgentSig
  and cardPop are present together or not at all (the signer: and only with agentCard), cardPop is
  bare 128 lowercase hex and cardAgentSig is canonical ECDSA. Whether they verify is not a shape check.

Negative cases: each signature replayed from another card (another key epoch, with and without new
keys, owner, display name, relays, issuedAt, expiresAt, another agent); a pair whose halves are for
two different cards; one signature without the other; a cardPop by the owner's Nostr key, under the
envelope or owner-action tag, untagged, over the JCS bytes, over the EIP-712 digest; malformed
encodings (upper case, 0x, short, long, empty, non-string, r = p, s = n, a flipped bit); cards that do
not parse. Every expected value is recomputed by this script's own verifier and model and must equal
the case's intent, or nothing is written. Keys are synthetic test values derived from labelled seeds.

Usage: python3 -I tools/vectors/generate_card_pop.py --check [FILE] | --write
"""

import copy
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import generate_eip712 as e  # noqa: E402
import vectorlib as v  # noqa: E402

SUITE = "card-pop"
VERSION = 1

CARD_POP_TAG = "agentlink/card-pop/v1"
ENVELOPE_TAG = "agentlink/envelope/v1"
OWNER_ACTION_TAG = "agentlink/owner-action/v1"
SECP256K1_P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F

SPEC = "04 §2.9 (D-102)"
PACK = "07 §8 signer (D-102)"
UPDATE = "04 §3.4.1 card-update (D-102)"

NAME = "Alice's agent"
RELAYS = ["wss://relay.example.com", "wss://relay.example.net"]


# --- keys and cards ------------------------------------------------------------------------------


def keys(label, epoch=0):
    """Synthetic secret keys of one agent and its owner. The agent keys change with the epoch, the
    agent EVM key never does (04 §2.9: agentId is the epoch-0 EVM address)."""
    return {
        "agentEvm": v.det(f"card-pop/{label}/agent/evm", 32),
        "agentNostr": v.det(f"card-pop/{label}/agent/nostr/{epoch}", 32),
        "agentEnc": v.det(f"card-pop/{label}/agent/enc/{epoch}", 32),
        "ownerEvm": v.det(f"card-pop/{label}/owner/evm", 32),
        "ownerNostr": v.det(f"card-pop/{label}/owner/nostr", 32),
        "ownerEnc": v.det(f"card-pop/{label}/owner/enc", 32),
    }


def card_from(k, *, name=NAME, relays=RELAYS, issued_at=1760000000, expires_at=0, key_epoch=0):
    name_hash, relays_hash = e.card_hashes(name, relays)
    return {
        "version": 1,
        "agentEvm": v.evm_address(k["agentEvm"]),
        "agentNostr": e.b32(v.xonly_public_key(k["agentNostr"])),
        "agentEnc": e.b32(v.x25519_public_key(k["agentEnc"])),
        "ownerEvm": v.evm_address(k["ownerEvm"]),
        "ownerNostr": e.b32(v.xonly_public_key(k["ownerNostr"])),
        "ownerEnc": e.b32(v.x25519_public_key(k["ownerEnc"])),
        "nameHash": name_hash,
        "relaysHash": relays_hash,
        "issuedAt": issued_at,
        "expiresAt": expires_at,
        "keyEpoch": key_epoch,
    }


def parse(card):
    """The card checks of 04 §2.4, §2.4.1, §2.9: generate_eip712's strict form plus version 1."""
    e.parse_card(card)
    if card["version"] != 1:
        raise ValueError("card version must be 1")
    return card


def card_hash(card):
    return v.sha256(v.jcs(card))


def pop_message(card, tag=CARD_POP_TAG):
    return v.tagged_hash(tag, card_hash(card))


def aux(label):
    return v.det(f"card-pop/aux/{label}", 32)


def sign_pop(secret, message32, aux_label="default"):
    return v.schnorr_sign(secret, message32, aux(aux_label)).hex()


def agent_sig(secret, card):
    return e.card_sig(secret, e.card_digest(card))


# --- this generator's own verifier and shape model -----------------------------------------------

POP_RE = re.compile(r"[0-9a-f]{128}")


def verify_pop(card, pop):
    try:
        parse(card)
    except (ValueError, KeyError, TypeError):
        return False
    if not isinstance(pop, str) or not POP_RE.fullmatch(pop):
        return False
    return v.schnorr_verify(bytes.fromhex(card["agentNostr"][2:]), pop_message(card), bytes.fromhex(pop))


def verify_agent_sig(card, sig):
    return e.verify_card_sig(card, sig, signer_field="agentEvm")


def verify_possession(card, sig, pop):
    return sig is not None and pop is not None and verify_agent_sig(card, sig) and verify_pop(card, pop)


def canonical_ecdsa(sig):
    if not isinstance(sig, str) or not re.fullmatch(r"0x[0-9a-f]{130}", sig):
        return False
    r, s, vb = int(sig[2:66], 16), int(sig[66:130], 16), int(sig[130:132], 16)
    return 1 <= r < v.SECP256K1_N and 1 <= s <= v.SECP256K1_N // 2 and vb in (27, 28)


def pop_shape(pop):
    return isinstance(pop, str) and POP_RE.fullmatch(pop) is not None


def card_ok(card):
    try:
        parse(card)
        return True
    except (ValueError, KeyError, TypeError):
        return False


def signer_shape(signer):
    """07 §8 `signer`: strict {evm, agentCard?, cardSig?, cardAgentSig?, cardPop?}; cardAgentSig and
    cardPop together or not at all, and only with agentCard."""
    allowed = {"evm", "agentCard", "cardSig", "cardAgentSig", "cardPop"}
    if not isinstance(signer, dict) or not set(signer) <= allowed or "evm" not in signer:
        return False
    if not isinstance(signer["evm"], str) or not re.fullmatch(r"0x[0-9a-f]{40}", signer["evm"]):
        return False
    if "agentCard" in signer and not card_ok(signer["agentCard"]):
        return False
    if "cardSig" in signer and not canonical_ecdsa(signer["cardSig"]):
        return False
    if "cardAgentSig" in signer and not canonical_ecdsa(signer["cardAgentSig"]):
        return False
    if "cardPop" in signer and not pop_shape(signer["cardPop"]):
        return False
    if ("cardAgentSig" in signer) != ("cardPop" in signer):
        return False
    return not ("cardAgentSig" in signer and "agentCard" not in signer)


def card_update_shape(body):
    """04 §3.4.1 `card-update` body: strict {card, cardSig, cardAgentSig?, cardPop?, name, relays}.
    `name` and `relays` are always the fixed valid NAME and RELAYS here (the pairing-bodies suite
    covers their rules), so only the card and the signatures vary."""
    required = {"card", "cardSig", "name", "relays"}
    if not isinstance(body, dict) or not required <= set(body) <= required | {"cardAgentSig", "cardPop"}:
        return False
    if body["name"] != NAME or body["relays"] != RELAYS:
        v.fail("card-update cases use the fixed NAME and RELAYS only")
    if not card_ok(body["card"]) or not canonical_ecdsa(body["cardSig"]):
        return False
    if "cardAgentSig" in body and not canonical_ecdsa(body["cardAgentSig"]):
        return False
    if "cardPop" in body and not pop_shape(body["cardPop"]):
        return False
    return ("cardAgentSig" in body) == ("cardPop" in body)


def outcome(accepted):
    return {"outcome": "accept" if accepted else "reject"}


# --- cases ---------------------------------------------------------------------------------------


def build():
    cases = []

    def add(case_id, source, input_, expected):
        cases.append(v.case(case_id, source, input_, expected))

    def expect(case_id, computed, intended):
        if computed != intended:
            v.fail(f"{case_id}: this generator's verifier says {computed}, the case intends {intended}")
        return outcome(computed)

    k0 = keys("alice", 0)
    card = card_from(k0)
    parse(card)
    pop = sign_pop(k0["agentNostr"], pop_message(card))
    sig = agent_sig(k0["agentEvm"], card)
    if not verify_pop(card, pop) or not verify_agent_sig(card, sig):
        v.fail("the base pair does not verify")

    # Cards the base pair must not verify for (04 §2.9 "Replay").
    k1 = keys("alice", 1)
    rotated = card_from(k1, key_epoch=1)
    epoch_only = dict(card, keyEpoch=1)
    k_other_owner = dict(k0, **{f: v.det(f"card-pop/mallory/owner/{f}", 32) for f in ("ownerEvm", "ownerNostr", "ownerEnc")})
    other_owner = card_from(k_other_owner)
    renamed = card_from(k0, name="Alice's other agent")
    relays_changed = card_from(k0, relays=["wss://relay.example.com", "wss://nostr.example.org:7447/inbox"])
    reissued = card_from(k0, issued_at=1760000001)
    expiring = card_from(k0, expires_at=1791536000)
    kb = keys("bob", 0)
    bob = card_from(kb, name="Bob's agent")
    variants = [
        ("key-epoch", "another key epoch with the rotated keys (04 §2.6)", rotated),
        ("key-epoch-only", "the same keys with only keyEpoch changed", epoch_only),
        ("owner", "the same agent keys under another owner", other_owner),
        ("display-name", "another display name (nameHash)", renamed),
        ("relays", "another relay list (relaysHash)", relays_changed),
        ("issued-at", "another issuedAt", reissued),
        ("expires-at", "another expiresAt", expiring),
        ("agent", "another agent's card", bob),
    ]
    for _, _, other in variants:
        parse(other)
        if card_hash(other) == card_hash(card):
            v.fail("a replay variant has the base card's hash")

    # cardPopMessage: tag, card hash and message, for the base card and two variants.
    for case_id, c in [("base", card), ("key-epoch", rotated), ("expires-at", expiring)]:
        add(
            f"message-{case_id}",
            f"{SPEC}: taggedHash(\"{CARD_POP_TAG}\", sha256(JCS(card))); the card hash of 04 §3.6",
            {"op": "cardPopMessage", "card": c},
            {"tag": CARD_POP_TAG, "cardHash": card_hash(c).hex(), "message": pop_message(c).hex()},
        )

    # signCardPop: deterministic with a fixed auxRand.
    for case_id, c, secret, aux_label in [
        ("base", card, k0["agentNostr"], "default"),
        ("base-other-aux", card, k0["agentNostr"], "other"),
        ("key-epoch", rotated, k1["agentNostr"], "default"),
        ("expires-at", expiring, k0["agentNostr"], "default"),
        ("agent", bob, kb["agentNostr"], "default"),
    ]:
        signed = sign_pop(secret, pop_message(c), aux_label)
        if not verify_pop(c, signed):
            v.fail(f"sign-{case_id} does not verify")
        add(
            f"sign-{case_id}",
            f"{SPEC}: BIP-340 by agentNostr over the card-pop message, auxRand fixed for the vector",
            {"op": "signCardPop", "card": c, "secretKey": secret.hex(), "auxRand": aux(aux_label).hex()},
            {"cardPop": signed},
        )
    for case_id, why, c, secret in [
        ("owner-nostr-key", "the owner's Nostr key is not the card's agentNostr", card, k0["ownerNostr"]),
        ("previous-epoch-key", "the epoch-0 Nostr key for the epoch-1 card", rotated, k0["agentNostr"]),
        ("evm-key", "the agent EVM key is not the card's agentNostr", card, k0["agentEvm"]),
        ("agent-equals-owner", "a card whose agentEvm equals its ownerEvm (04 §2.9)", dict(card, ownerEvm=card["agentEvm"]), k0["agentNostr"]),
        ("upper-case-card", "a card with an upper-case agentNostr (04 §2.4.1)", dict(card, agentNostr=card["agentNostr"].upper().replace("0X", "0x")), k0["agentNostr"]),
    ]:
        add(
            f"sign-reject-{case_id}",
            f"{SPEC}: refused: {why}",
            {"op": "signCardPop", "card": c, "secretKey": secret.hex(), "auxRand": aux("default").hex()},
            {"outcome": "reject"},
        )

    # verifyCardPop: valid.
    for case_id, c, p in [
        ("base", card, pop),
        ("base-other-aux", card, sign_pop(k0["agentNostr"], pop_message(card), "other")),
        ("key-epoch", rotated, sign_pop(k1["agentNostr"], pop_message(rotated))),
        ("agent", bob, sign_pop(kb["agentNostr"], pop_message(bob))),
    ]:
        add(f"pop-valid-{case_id}", f"{SPEC}: cardPop by this card's agentNostr over this card", {"op": "verifyCardPop", "card": c, "cardPop": p}, expect(f"pop-valid-{case_id}", verify_pop(c, p), True))

    # verifyCardPop: replayed onto another card.
    for case_id, why, other in variants:
        add(
            f"pop-replay-{case_id}",
            f"{SPEC} Replay: the base card's cardPop moved to {why}",
            {"op": "verifyCardPop", "card": other, "cardPop": pop},
            expect(f"pop-replay-{case_id}", verify_pop(other, pop), False),
        )
    # The rotated card's own cardPop moved back to the epoch-0 card.
    rotated_pop = sign_pop(k1["agentNostr"], pop_message(rotated))
    add(
        "pop-replay-key-epoch-back",
        f"{SPEC} Replay: the epoch-1 card's cardPop moved back to the epoch-0 card",
        {"op": "verifyCardPop", "card": card, "cardPop": rotated_pop},
        expect("pop-replay-key-epoch-back", verify_pop(card, rotated_pop), False),
    )
    # The epoch-0 Nostr key signing the epoch-1 card: right card, key no longer named in it.
    stale = sign_pop(k0["agentNostr"], pop_message(rotated))
    add(
        "pop-reject-previous-epoch-key",
        f"{SPEC}: the epoch-1 card signed by the epoch-0 Nostr key, which the card does not name",
        {"op": "verifyCardPop", "card": rotated, "cardPop": stale},
        expect("pop-reject-previous-epoch-key", verify_pop(rotated, stale), False),
    )

    # verifyCardPop: the wrong key, tag or message (domain separation, 04 §2.9).
    jcs_bytes = v.jcs(card)
    wrong = [
        ("owner-nostr-key", "the owner's Nostr key instead of agentNostr", sign_pop(k0["ownerNostr"], pop_message(card))),
        ("envelope-tag", f"the envelope tag {ENVELOPE_TAG} (04 §3.1)", sign_pop(k0["agentNostr"], pop_message(card, ENVELOPE_TAG))),
        ("owner-action-tag", f"the owner-action tag {OWNER_ACTION_TAG} (04 §2.5.1)", sign_pop(k0["agentNostr"], pop_message(card, OWNER_ACTION_TAG))),
        ("untagged", "the untagged card hash sha256(JCS(card))", sign_pop(k0["agentNostr"], card_hash(card))),
        ("tag-over-jcs", "the tag over the JCS bytes, not their hash", sign_pop(k0["agentNostr"], v.tagged_hash(CARD_POP_TAG, jcs_bytes))),
        ("eip712-digest", "the card's EIP-712 digest", sign_pop(k0["agentNostr"], e.card_digest(card))),
    ]
    for case_id, why, p in wrong:
        add(
            f"pop-reject-{case_id}",
            f"{SPEC}: a BIP-340 signature by {why}",
            {"op": "verifyCardPop", "card": card, "cardPop": p},
            expect(f"pop-reject-{case_id}", verify_pop(card, p), False),
        )

    # verifyCardPop: malformed encodings.
    r_hex, s_hex = pop[:64], pop[64:]
    flipped = format(int(pop[-1], 16) ^ 1, "x")
    malformed = [
        ("upper-case", "upper-case hex", pop.upper()),
        ("prefixed-0x", "a 0x prefix", "0x" + pop),
        ("short", "63 bytes", pop[:126]),
        ("long", "65 bytes", pop + "00"),
        ("empty", "an empty string", ""),
        ("number", "a JSON number", 1),
        ("null", "null", None),
        ("array", "an array", [pop]),
        ("card-agent-sig", "the card's cardAgentSig in the cardPop field", sig),
        ("r-equals-p", "r = p (BIP-340: r must be below the field size)", format(SECP256K1_P, "064x") + s_hex),
        ("s-equals-n", "s = n (BIP-340: s must be below the group order)", r_hex + format(v.SECP256K1_N, "064x")),
        ("flipped-bit", "the last bit flipped", pop[:-1] + flipped),
    ]
    for case_id, why, p in malformed:
        add(
            f"pop-malformed-{case_id}",
            f"{SPEC}, 04 §2.4.1 (bare 128 hex): cardPop as {why}",
            {"op": "verifyCardPop", "card": card, "cardPop": p},
            expect(f"pop-malformed-{case_id}", verify_pop(card, p), False),
        )

    # verifyCardPop: cards that do not parse, signed over their own JCS by their agentNostr.
    bad_cards = [
        ("agent-equals-owner", "agentEvm equals ownerEvm (04 §2.9)", dict(card, ownerEvm=card["agentEvm"])),
        ("extra-field", "a thirteenth field", dict(card, extra=1)),
        ("version-2", "version 2", dict(card, version=2)),
        ("upper-case-owner", "an upper-case ownerEvm", dict(card, ownerEvm="0x" + card["ownerEvm"][2:].upper())),
    ]
    for case_id, why, bad in bad_cards:
        if card_ok(bad):
            v.fail(f"pop-card-{case_id}: the card parses")
        p = sign_pop(k0["agentNostr"], v.tagged_hash(CARD_POP_TAG, v.sha256(v.jcs(bad))))
        add(
            f"pop-card-reject-{case_id}",
            f"{SPEC}, 04 §2.4: a card with {why} is refused before any signature check",
            {"op": "verifyCardPop", "card": bad, "cardPop": p},
            expect(f"pop-card-reject-{case_id}", verify_pop(bad, p), False),
        )

    # verifyCardPossession: both, one without the other, crossed halves, replays.
    rotated_sig = agent_sig(k0["agentEvm"], rotated)
    bob_sig = agent_sig(kb["agentEvm"], bob)
    bob_pop = sign_pop(kb["agentNostr"], pop_message(bob))
    possession = [
        ("valid-base", "both signatures over this card", card, sig, pop, True),
        ("valid-key-epoch", "both over the epoch-1 card (the EVM key is the same at every epoch)", rotated, rotated_sig, rotated_pop, True),
        ("valid-agent", "another agent's own pair", bob, bob_sig, bob_pop, True),
        ("missing-card-pop", "cardAgentSig without cardPop", card, sig, None, False),
        ("missing-card-agent-sig", "cardPop without cardAgentSig", card, None, pop, False),
        ("missing-both", "neither signature", card, None, None, False),
        ("crossed-epoch-pop", "cardAgentSig for this card, cardPop from the epoch-1 card", card, sig, rotated_pop, False),
        ("crossed-epoch-agent-sig", "cardPop for this card, cardAgentSig from the epoch-1 card", card, rotated_sig, pop, False),
        ("crossed-agent", "cardAgentSig for this card, cardPop from another agent's card", card, sig, bob_pop, False),
        ("swapped-fields", "the two signatures in each other's fields", card, pop, sig, False),
        ("owner-sig-as-agent-sig", "the owner's cardSig as cardAgentSig (05 §4)", card, e.card_sig(k0["ownerEvm"], e.card_digest(card)), pop, False),
    ]
    for case_id, why, other in variants:
        possession.append((f"replay-{case_id}", f"the base pair moved to {why}", other, sig, pop, False))
    for case_id, why, c, s, p, intended in possession:
        input_ = {"op": "verifyCardPossession", "card": c}
        if s is not None:
            input_["cardAgentSig"] = s
        if p is not None:
            input_["cardPop"] = p
        add(
            f"possession-{case_id}",
            f"{SPEC}, {PACK}: {why}",
            input_,
            expect(f"possession-{case_id}", verify_possession(c, s, p), intended),
        )

    # signerShape (07 §8): presence and encoding only; verification is the verifier's.
    card_sig = e.card_sig(k0["ownerEvm"], e.card_digest(card))
    base_signer = {"evm": card["agentEvm"], "agentCard": card, "cardSig": card_sig}
    r_sig, s_sig = int(sig[2:66], 16), int(sig[66:130], 16)
    high_s = "0x" + format(r_sig, "064x") + format(v.SECP256K1_N - s_sig, "064x") + format(55 - int(sig[130:], 16), "02x")

    def without(d, *names):
        return {k: val for k, val in d.items() if k not in names}

    signers = [
        ("both", "agentCard with cardAgentSig and cardPop", dict(base_signer, cardAgentSig=sig, cardPop=pop), True),
        ("neither", "agentCard without them (a pack stays record_only, card_pop_missing)", base_signer, True),
        ("evm-only", "evm only", {"evm": card["agentEvm"]}, True),
        ("only-card-agent-sig", "cardAgentSig without cardPop", dict(base_signer, cardAgentSig=sig), False),
        ("only-card-pop", "cardPop without cardAgentSig", dict(base_signer, cardPop=pop), False),
        ("without-card", "both without agentCard", {"evm": card["agentEvm"], "cardAgentSig": sig, "cardPop": pop}, False),
        ("pop-upper-case", "cardPop in upper case", dict(base_signer, cardAgentSig=sig, cardPop=pop.upper()), False),
        ("pop-prefixed-0x", "cardPop with 0x", dict(base_signer, cardAgentSig=sig, cardPop="0x" + pop), False),
        ("pop-short", "cardPop of 63 bytes", dict(base_signer, cardAgentSig=sig, cardPop=pop[:126]), False),
        ("pop-null", "cardPop null", dict(base_signer, cardAgentSig=sig, cardPop=None), False),
        ("agent-sig-bare", "cardAgentSig without 0x", dict(base_signer, cardAgentSig=sig[2:], cardPop=pop), False),
        ("agent-sig-high-s", "cardAgentSig in its high-s form (04 §2.4.1)", dict(base_signer, cardAgentSig=high_s, cardPop=pop), False),
        ("agent-sig-v-0", "cardAgentSig with v = 0", dict(base_signer, cardAgentSig=sig[:130] + format(int(sig[130:], 16) - 27, "02x"), cardPop=pop), False),
        ("extra-key", "an unknown key next to the signatures", dict(base_signer, cardAgentSig=sig, cardPop=pop, cardPops=[pop]), False),
    ]
    if canonical_ecdsa(high_s) or e.verify_card_sig(card, high_s, "agentEvm"):
        v.fail("the high-s form is canonical")
    for case_id, why, s, intended in signers:
        add(
            f"signer-{'accept' if intended else 'reject'}-{case_id}",
            f"{PACK}: {why}; any other combination is malformed_pack",
            {"op": "signerShape", "signer": s},
            expect(f"signer-{case_id}", signer_shape(s), intended),
        )

    # cardUpdateShape (04 §3.4.1).
    base_body = {"card": card, "cardSig": card_sig, "name": NAME, "relays": RELAYS}
    bodies = [
        ("both", "cardAgentSig and cardPop", dict(base_body, cardAgentSig=sig, cardPop=pop), True),
        ("neither", "neither (a peer before M1-4d-d)", base_body, True),
        ("only-card-agent-sig", "cardAgentSig without cardPop", dict(base_body, cardAgentSig=sig), False),
        ("only-card-pop", "cardPop without cardAgentSig", dict(base_body, cardPop=pop), False),
        ("pop-upper-case", "cardPop in upper case", dict(base_body, cardAgentSig=sig, cardPop=pop.upper()), False),
        ("pop-long", "cardPop of 65 bytes", dict(base_body, cardAgentSig=sig, cardPop=pop + "00"), False),
        ("agent-sig-high-s", "cardAgentSig in its high-s form", dict(base_body, cardAgentSig=high_s, cardPop=pop), False),
    ]
    for case_id, why, b, intended in bodies:
        add(
            f"card-update-{'accept' if intended else 'reject'}-{case_id}",
            f"{UPDATE}: {why}; together or not at all",
            {"op": "cardUpdateShape", "body": b},
            expect(f"card-update-{case_id}", card_update_shape(b), intended),
        )

    # No case may alias the base card object (the JSON is written per case).
    return copy.deepcopy(cases)


HEX32 = v.hexn(32)
SCHEMA = v.case_schema(
    SUITE,
    "The agent card's proof of possession (04 §2.9, 07 §8, D-102). `cardPopMessage`: the tag, "
    "sha256(JCS(card)) and taggedHash(tag, cardHash), bare hex. `signCardPop`: the BIP-340 cardPop "
    "(bare 128 hex) by the card's agentNostr secret key with a fixed auxRand, or a rejection. "
    "`verifyCardPop`, `verifyCardPossession` (cardAgentSig and cardPop, each optional to test its "
    "absence): accept or reject. `signerShape` (the proof pack `signer`) and `cardUpdateShape` (the "
    "`card-update` body): whether the strict schema accepts the presence and encodings.",
    {
        "cardPopMessage": ({"card": v.OBJECT}, [{"tag": {"const": CARD_POP_TAG}, "cardHash": HEX32, "message": HEX32}]),
        "signCardPop": ({"card": v.OBJECT, "secretKey": HEX32, "auxRand": HEX32}, [{"cardPop": v.hexn(64)}, v.REJECT]),
        "verifyCardPop": ({"card": v.OBJECT, "cardPop": v.ANY}, [v.ACCEPT, v.REJECT]),
        "verifyCardPossession": ({"card": v.OBJECT, "cardAgentSig": v.STRING, "cardPop": v.STRING}, [v.ACCEPT, v.REJECT]),
        "signerShape": ({"signer": v.OBJECT}, [v.ACCEPT, v.REJECT]),
        "cardUpdateShape": ({"body": v.OBJECT}, [v.ACCEPT, v.REJECT]),
    },
)
v.optional_input(SCHEMA, "verifyCardPossession", "cardAgentSig")
v.optional_input(SCHEMA, "verifyCardPossession", "cardPop")

if __name__ == "__main__":
    v.main(
        suite=SUITE,
        version=VERSION,
        script="tools/vectors/generate_card_pop.py",
        libraries=["cryptography", "coincurve", "pycryptodome", "rfc8785"],
        build=build,
        schema=SCHEMA,
        doc=__doc__,
    )
