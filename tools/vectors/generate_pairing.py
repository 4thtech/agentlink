#!/usr/bin/env python3
"""Independent generator for the `pairing` suite: HMAC-SHA256 for the pairing proof (M1-1h).

04 §3.6: proof = HMAC-SHA256(secret, utf8("agentlink-handshake") || inviteId || sha256(JCS(B card))).
First the RFC 4231 HMAC-SHA256 test cases 1-4, 6 and 7 (case 5 is a truncated output), recomputed
with CPython's hmac/hashlib. Then the AgentLink proof with the byte-exact input of 04 §3.6:
proofKey = HKDF-SHA256(ikm = the 32 raw bytes of `secret`, salt = "", info =
utf8("agentlink/v1/pairing-proof"), L = 32); proof = HMAC-SHA256(proofKey, utf8("agentlink-handshake")
|| the 16 raw bytes of `inviteId` || sha256(JCS(card))) with B's card in the card JSON form (04 §2.4);
`proof` is base64url of the 32-byte MAC. The raw `secret` is never an HMAC key. `secret`, `inviteId` and `proof` are base64url without padding (§2.4.1). JCS is `rfc8785`;
the card comes from the `eip712` generator. The safety code waits for G-28.

Usage: python3 -I tools/vectors/generate_pairing.py --check [FILE] | --write
"""

import copy
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import generate_eip712 as eip712  # noqa: E402
import vectorlib as v  # noqa: E402

SUITE = "pairing"
VERSION = 1
SPEC = "04 §3.6 pairing proof"
LABEL = b"agentlink-handshake"
PROOF_KEY_INFO = b"agentlink/v1/pairing-proof"


def proof_key(secret):
    return v.hkdf_sha256(secret, b"", PROOF_KEY_INFO, 32)


def proof_of(secret, invite_id, card):
    return v.hmac_sha256(proof_key(secret), LABEL + invite_id + v.sha256(v.jcs(card)))


def verify(secret_b64u, invite_b64u, card, proof_b64u):
    try:
        secret, invite_id, proof = v.unb64u(secret_b64u), v.unb64u(invite_b64u), v.unb64u(proof_b64u)
        eip712.parse_card(card)
    except ValueError:
        return False
    if len(secret) != 32 or len(invite_id) != 16 or len(proof) != 32:
        return False
    return v._hmac.compare_digest(proof, proof_of(secret, invite_id, card))

# RFC 4231 section 4: (case, key hex, data hex, published HMAC-SHA-256).
RFC4231 = [
    (1, "0b" * 20, b"Hi There".hex(), "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"),
    (2, b"Jefe".hex(), b"what do ya want for nothing?".hex(), "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"),
    (3, "aa" * 20, "dd" * 50, "773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe"),
    (4, bytes(range(1, 26)).hex(), "cd" * 50, "82558a389a443c0ea4cc819899f2083a85f0faa3e578f8077a2e3ff46729665b"),
    (6, "aa" * 131, b"Test Using Larger Than Block-Size Key - Hash Key First".hex(), "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"),
    (
        7,
        "aa" * 131,
        b"This is a test using a larger than block-size key and a larger than block-size data. "
        b"The key needs to be hashed before being used by the HMAC algorithm.".hex(),
        "9b09ffa71b942fcb27635fbcd5b0e944bfdc63644f0713938a7f51535c3a35e2",
    ),
]


def build():
    cases = []
    for number, key, data, published in RFC4231:
        if v.hmac_sha256(v.unhex(key), v.unhex(data)).hex() != published:
            v.fail(f"HMAC-SHA256 disagrees with RFC 4231 test case {number}")
        cases.append(
            v.case(
                f"rfc4231-{number}",
                f"RFC 4231 §4 test case {number}, HMAC-SHA-256 (published)",
                {"op": "hmacSha256", "key": key, "data": data},
                {"mac": published},
            )
        )

    card = eip712.make_card("pairing-b", "Denis's Codex", ["wss://relay.example.com"], 1760000000, 1791536000, 0)
    secret = v.det("pairing/secret", 32)
    invite_id = v.det("pairing/invite-id", 16)
    proof = proof_of(secret, invite_id, card)
    jcs_card = v.jcs(card)
    cases.append(
        v.case(
            "proof",
            SPEC,
            {"op": "pairingProof", "secret": v.b64u(secret), "inviteId": v.b64u(invite_id), "card": card},
            {"proofKey": v.hx(proof_key(secret)), "cardJcsSha256": v.hx(v.sha256(jcs_card)), "proof": v.b64u(proof)},
        )
    )
    unordered = dict(reversed(list(card.items())))
    cases.append(
        v.case(
            "proof-card-key-order",
            f"{SPEC}: the same card with its keys in another order gives the same proof (JCS)",
            {"op": "pairingProof", "secret": v.b64u(secret), "inviteId": v.b64u(invite_id), "card": unordered},
            {"proofKey": v.hx(proof_key(secret)), "cardJcsSha256": v.hx(v.sha256(jcs_card)), "proof": v.b64u(proof)},
        )
    )

    def verify_case(case_id, why, accept, secret_=None, invite_=None, card_=None, proof_=None):
        args = (
            v.b64u(secret) if secret_ is None else secret_,
            v.b64u(invite_id) if invite_ is None else invite_,
            card if card_ is None else card_,
            v.b64u(proof) if proof_ is None else proof_,
        )
        if verify(*args) != accept:
            v.fail(f"{case_id}: unexpected result")
        cases.append(
            v.case(
                case_id,
                f"{SPEC}: {why}",
                {"op": "verifyPairingProof", "secret": args[0], "inviteId": args[1], "card": args[2], "proof": args[3]},
                {"outcome": "accept" if accept else "reject"},
            )
        )

    other_card = copy.deepcopy(card)
    other_card["keyEpoch"] = 1
    raw_secret_key = v.hmac_sha256(secret, LABEL + invite_id + v.sha256(jcs_card))
    text_id = v.hmac_sha256(proof_key(secret), LABEL + v.b64u(invite_id).encode() + v.sha256(jcs_card))
    plain_json = v.hmac_sha256(proof_key(secret), LABEL + invite_id + v.sha256(json.dumps(card).encode()))
    bad_card = copy.deepcopy(card)
    bad_card["agentNostr"] = "0x" + card["agentNostr"][2:].upper()
    verify_case("verify", "the proof matches", True)
    verify_case("verify-reject-wrong-secret", "another invite secret", False, secret_=v.b64u(v.det("pairing/other-secret", 32)))
    verify_case("verify-reject-other-invite", "another inviteId", False, invite_=v.b64u(v.det("pairing/other-invite", 16)))
    verify_case("verify-reject-card-changed", "B's card changed (keyEpoch)", False, card_=other_card)
    verify_case("verify-reject-raw-secret-key", "the proof was keyed with the raw secret instead of proofKey", False, proof_=v.b64u(raw_secret_key))
    verify_case("verify-reject-invite-id-as-text", "the proof was built over the base64url text of inviteId", False, proof_=v.b64u(text_id))
    verify_case("verify-reject-card-not-jcs", "the proof was built over a non-JCS serialisation of the card", False, proof_=v.b64u(plain_json))
    verify_case("verify-reject-proof-padded", "proof as padded base64url", False, proof_=v.b64u(proof) + "=")
    verify_case("verify-reject-proof-31-bytes", "a 31-byte proof", False, proof_=v.b64u(proof[:31]))
    verify_case("verify-reject-secret-padded", "secret as padded base64url", False, secret_=v.b64u(secret) + "=")
    verify_case("verify-reject-card-non-canonical", "a card field in upper-case hex", False, card_=bad_card)
    return cases


SCHEMA = v.case_schema(
    SUITE,
    "04 §3.6 pairing proof. `hmacSha256`: RFC 4231. `pairingProof`: proofKey, sha256(JCS(card)) and the "
    "base64url proof for secret, inviteId and B's card. `verifyPairingProof`: accept or reject.",
    {
        "hmacSha256": ({"key": v.HEX, "data": v.HEX}, [{"mac": v.hexn(32)}]),
        "pairingProof": ({"secret": v.B64U, "inviteId": v.B64U, "card": v.OBJECT}, [{"proofKey": v.hexn(32), "cardJcsSha256": v.hexn(32), "proof": v.B64U}]),
        "verifyPairingProof": ({"secret": v.STRING, "inviteId": v.STRING, "card": v.OBJECT, "proof": v.STRING}, [v.ACCEPT, v.REJECT]),
    },
)

if __name__ == "__main__":
    v.main(
        suite=SUITE,
        version=VERSION,
        script="tools/vectors/generate_pairing.py",
        libraries=["cryptography", "coincurve", "pycryptodome", "rfc8785"],
        build=build,
        schema=SCHEMA,
        doc=__doc__,
    )
