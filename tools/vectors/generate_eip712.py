#!/usr/bin/env python3
"""Independent generator for the `eip712` suite: EIP-712 hashing and the AgentCard (M1-1h).

EIP-712 encoding (encodeType, typeHash, encodeData, hashStruct, domain separator and
digest = keccak256(0x1901 || domainSeparator || hashStruct(message))) is composed here from
Keccak-256 (pycryptodome) for the static types AgentLink uses and for the EIP's own example.
Signatures are deterministic ECDSA (RFC 6979, low s) from libsecp256k1 (coincurve). Before writing
anything the generator reproduces the official EIP-712 example ("Ether Mail", ethereum/EIPs
assets/eip-712/Example.js, commit e1e9c0c01cb57a7ec04359f3a3ccf7d0b72486cd): encodeType, typeHash,
encodeData, hashStruct, the domain separator, the digest and the signature by keccak256("cow").

AgentCard (04 §2.4; M1-1e): chain-agnostic domain {name: "OCC AgentCard", version: "1"} with no
chainId and no verifyingContract, and the struct with the field order of 04 §2.4. nameHash =
keccak256(utf8(name)); relaysHash = keccak256(JCS(relays)) (RFC 8785, `rfc8785`). Cards are in
the card JSON form and `cardSig` is 0x + 130 lowercase hex (r || s || v, v in {27, 28}, low s),
per 04 §2.4 and §2.4.1 (canonical ECDSA: r and s in [1, n - 1], s <= n/2, v in {27, 28}). The card
is I-JSON with integer tokens matching 0|[1-9][0-9]*, so `agentCardJson` cases give raw JSON text. Keys are synthetic test values (the Mail key is the EIP's keccak256("cow")).

Negative cases: non-canonical cards (encodings, integer ranges, unknown or missing fields); a card
signature that does not verify for the card's ownerEvm after a field changes, under a domain that
adds chainId, under another domain, by another key, as the agent's own signature (cardAgentSig,
05 §4), in its malleated high-s form, with v as 0/1, without v, in upper case or without 0x.

Usage: python3 -I tools/vectors/generate_eip712.py --check [FILE] | --write
"""

import copy
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import vectorlib as v  # noqa: E402

SUITE = "eip712"
VERSION = 1
EXAMPLE = "EIP-712 Example.js (ethereum/EIPs@e1e9c0c0)"

AGENT_CARD_TYPES = {
    "EIP712Domain": [{"name": "name", "type": "string"}, {"name": "version", "type": "string"}],
    "AgentCard": [
        {"name": "version", "type": "uint8"},
        {"name": "agentEvm", "type": "address"},
        {"name": "agentNostr", "type": "bytes32"},
        {"name": "agentEnc", "type": "bytes32"},
        {"name": "ownerEvm", "type": "address"},
        {"name": "ownerNostr", "type": "bytes32"},
        {"name": "ownerEnc", "type": "bytes32"},
        {"name": "nameHash", "type": "bytes32"},
        {"name": "relaysHash", "type": "bytes32"},
        {"name": "issuedAt", "type": "uint64"},
        {"name": "expiresAt", "type": "uint64"},
        {"name": "keyEpoch", "type": "uint32"},
    ],
}
AGENT_CARD_DOMAIN = {"name": "OCC AgentCard", "version": "1"}

MAIL = {
    "types": {
        "EIP712Domain": [
            {"name": "name", "type": "string"},
            {"name": "version", "type": "string"},
            {"name": "chainId", "type": "uint256"},
            {"name": "verifyingContract", "type": "address"},
        ],
        "Person": [{"name": "name", "type": "string"}, {"name": "wallet", "type": "address"}],
        "Mail": [
            {"name": "from", "type": "Person"},
            {"name": "to", "type": "Person"},
            {"name": "contents", "type": "string"},
        ],
    },
    "primaryType": "Mail",
    "domain": {
        "name": "Ether Mail",
        "version": "1",
        "chainId": 1,
        "verifyingContract": "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC",
    },
    "message": {
        "from": {"name": "Cow", "wallet": "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826"},
        "to": {"name": "Bob", "wallet": "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB"},
        "contents": "Hello, Bob!",
    },
}
MAIL_PUBLISHED = {
    "encodeType": "Mail(Person from,Person to,string contents)Person(string name,address wallet)",
    "typeHash": "a0cedeb2dc280ba39b857546d74f5549c3a1d7bdc2dd96bf881f76108e23dac2",
    "encodeData": "a0cedeb2dc280ba39b857546d74f5549c3a1d7bdc2dd96bf881f76108e23dac2fc71e5fa27ff56c350aa531bc129ebdf613b772b6604664f5d8dbe21b85eb0c8cd54f074a4af31b4411ff6a60c9719dbd559c221c8ac3492d9d872b041d703d1b5aadf3154a261abdd9086fc627b61efca26ae5702701d05cd2305f7c52a2fc8",
    "structHash": "c52c0ee5d84264471806290a3f2c4cecfc5490626bf912d01f240d7a274b371e",
    "domainSeparator": "f2cee375fa42b42143804025fc449deafd50cc031ca257e0b194a650a912090f",
    "digest": "be609aee343fb3c4b28e1df9e632fca64fcfaede20f02e86244efddf30957bd2",
    "signer": "0xcd2a3d9f938e13cd947ec05abc7fe734df8dd826",
    "v": 28,
    "r": "4355c47d63924e8a72e509b65029052eb6c299d53a04e167c5775fd466751c9d",
    "s": "07299936d304c153f6443dfa05f40ff007d72911b6f72307f996231605b91562",
}


# --- EIP-712 encoding ----------------------------------------------------------------------------


def dependencies(types, primary, found=None):
    found = [] if found is None else found
    if primary in found or primary not in types:
        return found
    found.append(primary)
    for field in types[primary]:
        dependencies(types, field["type"], found)
    return found


def encode_type(types, primary):
    deps = dependencies(types, primary)
    deps = [primary] + sorted(d for d in deps if d != primary)
    return "".join(f"{d}(" + ",".join(f"{f['type']} {f['name']}" for f in types[d]) + ")" for d in deps)


def type_hash(types, primary):
    return v.keccak256(encode_type(types, primary).encode("utf-8"))


def encode_value(types, kind, value):
    if kind in types:
        return hash_struct(types, kind, value)
    if kind == "string":
        return v.keccak256(value.encode("utf-8"))
    if kind == "address":
        if not re.fullmatch(r"0x[0-9a-fA-F]{40}", value):
            v.fail(f"bad address {value}")
        return bytes(12) + bytes.fromhex(value[2:])
    if kind == "bytes32":
        raw = bytes.fromhex(value[2:])
        if len(raw) != 32:
            v.fail("bytes32 must be 32 bytes")
        return raw
    match = re.fullmatch(r"uint(\d+)", kind)
    if match:
        n = int(value)
        if not 0 <= n < 2 ** int(match.group(1)):
            v.fail(f"{value} does not fit {kind}")
        return n.to_bytes(32, "big")
    v.fail(f"type {kind} is not supported by this generator")


def encode_data(types, primary, data):
    return type_hash(types, primary) + b"".join(encode_value(types, f["type"], data[f["name"]]) for f in types[primary])


def hash_struct(types, primary, data):
    return v.keccak256(encode_data(types, primary, data))


def digest(types, primary, domain, message):
    return v.keccak256(b"\x19\x01" + hash_struct(types, "EIP712Domain", domain) + hash_struct(types, primary, message))


def ecdsa_sign(secret, message32):
    from coincurve import PrivateKey

    sig = PrivateKey(secret).sign_recoverable(message32, hasher=None)
    return sig[:32].hex(), sig[32:64].hex(), sig[64]


def recover(message32, r, s, y_parity):
    from coincurve import PublicKey

    try:
        public = PublicKey.from_signature_and_message(bytes.fromhex(r) + bytes.fromhex(s) + bytes([y_parity]), message32, hasher=None)
    except Exception:
        return None
    return "0x" + v.keccak256(public.format(compressed=False)[1:])[12:].hex()


# --- AgentCard -----------------------------------------------------------------------------------

UINT_BITS = {"version": 8, "issuedAt": 64, "expiresAt": 64, "keyEpoch": 32}
ADDRESS_FIELDS = ("agentEvm", "ownerEvm")
BYTES32_FIELDS = ("agentNostr", "agentEnc", "ownerNostr", "ownerEnc", "nameHash", "relaysHash")


def parse_card(card):
    """The card JSON form (04 §2.4, §2.4.1): exactly the
    twelve fields; addresses 0x + 40 lowercase hex; bytes32 0x + 64 lowercase hex; integers JSON
    integers in [0, 2^53 - 1] and within their uint type. Anything else is rejected."""
    if not isinstance(card, dict) or set(card) != {f["name"] for f in AGENT_CARD_TYPES["AgentCard"]}:
        raise ValueError("not exactly the twelve card fields")
    for name in ADDRESS_FIELDS:
        if not isinstance(card[name], str) or not re.fullmatch(r"0x[0-9a-f]{40}", card[name]):
            raise ValueError(f"{name} is not canonical")
    for name in BYTES32_FIELDS:
        if not isinstance(card[name], str) or not re.fullmatch(r"0x[0-9a-f]{64}", card[name]):
            raise ValueError(f"{name} is not canonical")
    if card["agentEvm"] == card["ownerEvm"]:
        raise ValueError("agentEvm equals ownerEvm (04 §2.9)")
    for name, bits in UINT_BITS.items():
        value = card[name]
        if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= min(2**53 - 1, 2**bits - 1):
            raise ValueError(f"{name} is out of range")
    return card


def parse_card_text(text):
    """Strict parse of a card's JSON text: duplicate keys refused, and every number token must match
    0|[1-9][0-9]* (04 §2.4.1), checked on the token, not the parsed value."""

    def pairs(items):
        names = [k for k, _ in items]
        if len(set(names)) != len(names):
            raise ValueError("duplicate key")
        return dict(items)

    def integer(token):
        if not re.fullmatch(r"0|[1-9][0-9]*", token):
            raise ValueError("non-canonical integer token")
        return int(token)

    def no_float(token):
        raise ValueError("non-integer number token")

    return parse_card(json.loads(text, object_pairs_hook=pairs, parse_int=integer, parse_float=no_float, parse_constant=no_float))


def card_digest(card, domain=AGENT_CARD_DOMAIN, domain_fields=None):
    types = dict(AGENT_CARD_TYPES)
    if domain_fields is not None:
        types["EIP712Domain"] = domain_fields
    return digest(types, "AgentCard", domain, card)


def card_hashes(name, relays):
    return "0x" + v.keccak256(name.encode("utf-8")).hex(), "0x" + v.keccak256(v.jcs(relays)).hex()


def b32(data):
    return "0x" + bytes(data).hex()


def card_sig(secret, message32):
    """cardSig: 0x + 130 lowercase hex, r || s || v with v in {27, 28} and low s (EIP-2)."""
    r, s, y = ecdsa_sign(secret, message32)
    return "0x" + r + s + format(27 + y, "02x")


def verify_card_sig(card, sig, signer_field="ownerEvm"):
    try:
        parse_card(card)
    except ValueError:
        return False
    if not isinstance(sig, str) or not re.fullmatch(r"0x[0-9a-f]{130}", sig):
        return False
    r, s, v_byte = sig[2:66], sig[66:130], int(sig[130:132], 16)
    if v_byte not in (27, 28) or not 1 <= int(r, 16) < v.SECP256K1_N or not 1 <= int(s, 16) <= v.SECP256K1_N // 2:
        return False
    signer = recover(card_digest(card), r, s, v_byte - 27)
    return signer is not None and bytes.fromhex(signer[2:]) == bytes.fromhex(card[signer_field][2:])


def make_card(label, name, relays, issued_at, expires_at, key_epoch):
    name_hash, relays_hash = card_hashes(name, relays)
    return {
        "version": 1,
        "agentEvm": v.evm_address(v.det(f"eip712/{label}/agent/evm", 32)),
        "agentNostr": b32(v.xonly_public_key(v.det(f"eip712/{label}/agent/nostr", 32))),
        "agentEnc": b32(v.x25519_public_key(v.det(f"eip712/{label}/agent/enc", 32))),
        "ownerEvm": v.evm_address(v.det(f"eip712/{label}/owner/evm", 32)),
        "ownerNostr": b32(v.xonly_public_key(v.det(f"eip712/{label}/owner/nostr", 32))),
        "ownerEnc": b32(v.x25519_public_key(v.det(f"eip712/{label}/owner/enc", 32))),
        "nameHash": name_hash,
        "relaysHash": relays_hash,
        "issuedAt": issued_at,
        "expiresAt": expires_at,
        "keyEpoch": key_epoch,
    }


CARD_FORM = "04 §2.4 card JSON form, §2.4.1"


def build():
    p = MAIL_PUBLISHED
    t = MAIL["types"]
    checks = [
        (encode_type(t, "Mail"), p["encodeType"]),
        (type_hash(t, "Mail").hex(), p["typeHash"]),
        (encode_data(t, "Mail", MAIL["message"]).hex(), p["encodeData"]),
        (hash_struct(t, "Mail", MAIL["message"]).hex(), p["structHash"]),
        (hash_struct(t, "EIP712Domain", MAIL["domain"]).hex(), p["domainSeparator"]),
        (digest(t, "Mail", MAIL["domain"], MAIL["message"]).hex(), p["digest"]),
    ]
    for ours, published in checks:
        if ours != published:
            v.fail(f"EIP-712 encoding gives {ours}, Example.js says {published}")
    cow = v.keccak256(b"cow")
    if v.evm_address(cow) != p["signer"]:
        v.fail("the address of keccak256('cow') differs from Example.js")
    r, s, y = ecdsa_sign(cow, bytes.fromhex(p["digest"]))
    if (r, s, 27 + y) != (p["r"], p["s"], p["v"]):
        v.fail("the signature differs from Example.js")

    cases = [
        v.case(
            "mail-hashes",
            f"{EXAMPLE}: domain separator, hashStruct(message), digest (published)",
            {"op": "typedData", "typedData": MAIL},
            {"domainSeparator": p["domainSeparator"], "structHash": p["structHash"], "digest": p["digest"]},
        ),
        v.case(
            "mail-sign",
            f"{EXAMPLE}: signature by keccak256(\"cow\"), r || s || v with v = 28 (published)",
            {"op": "signTypedData", "typedData": MAIL, "secretKey": cow.hex()},
            {"signature": "0x" + p["r"] + p["s"] + format(p["v"], "02x")},
        ),
    ]

    cards = [
        ("card-basic", make_card("basic", "Tali's Claude", ["wss://relay.example.com", "wss://nos.example.org"], 1760000000, 1791536000, 0)),
        ("card-no-expiry", make_card("no-expiry", "Research agent", ["wss://relay.example.com"], 1760000000, 0, 3)),
        ("card-limits", make_card("limits", "Ågent \U0001f916", [], 2**53 - 1, 2**53 - 1, 2**32 - 1)),
    ]
    for case_id, card in cards:
        parse_card(card)
        cases.append(
            v.case(
                f"{case_id}-hashes",
                "04 §2.4 AgentCard, chain-agnostic domain {name: \"OCC AgentCard\", version: \"1\"}; " + CARD_FORM,
                {"op": "agentCard", "card": card},
                {
                    "typeHash": type_hash(AGENT_CARD_TYPES, "AgentCard").hex(),
                    "domainSeparator": hash_struct(AGENT_CARD_TYPES, "EIP712Domain", AGENT_CARD_DOMAIN).hex(),
                    "structHash": hash_struct(AGENT_CARD_TYPES, "AgentCard", card).hex(),
                    "digest": card_digest(card).hex(),
                },
            )
        )

    card = cards[0][1]

    def card_variant(**changes):
        c = copy.deepcopy(card)
        for key, value in changes.items():
            if value is None:
                del c[key]
            else:
                c[key] = value
        return c

    for case_id, why, bad in [
        ("issued-at-2-pow-53", "issuedAt = 2^53 (uint64 above 2^53 - 1)", card_variant(issuedAt=2**53)),
        ("key-epoch-2-pow-32", "keyEpoch = 2^32 (outside uint32)", card_variant(keyEpoch=2**32)),
        ("version-256", "version = 256 (outside uint8)", card_variant(version=256)),
        ("issued-at-string", "issuedAt as a decimal string", card_variant(issuedAt="1760000000")),
        ("issued-at-negative", "issuedAt = -1", card_variant(issuedAt=-1)),
        ("agent-evm-checksummed", "agentEvm in EIP-55 mixed case", card_variant(agentEvm=v.eip55(card["agentEvm"]))),
        ("agent-nostr-uppercase", "agentNostr in upper-case hex", card_variant(agentNostr="0x" + card["agentNostr"][2:].upper())),
        ("owner-enc-no-prefix", "ownerEnc without 0x", card_variant(ownerEnc=card["ownerEnc"][2:])),
        ("owner-nostr-capital-prefix", "ownerNostr with 0X", card_variant(ownerNostr="0X" + card["ownerNostr"][2:])),
        ("name-hash-31-bytes", "nameHash of 31 bytes", card_variant(nameHash=card["nameHash"][:-2])),
        ("unknown-field", "a thirteenth field", card_variant(note="x")),
        ("missing-field", "relaysHash missing", card_variant(relaysHash=None)),
        ("agent-evm-equals-owner-evm", "agentEvm equal to ownerEvm (04 §2.9)", card_variant(agentEvm=card["ownerEvm"])),
    ]:
        try:
            parse_card(bad)
            v.fail(f"card {case_id} parses")
        except ValueError:
            pass
        cases.append(v.case(f"card-reject-{case_id}", f"{CARD_FORM}: {why}; rejected, never normalised", {"op": "agentCard", "card": bad}, {"outcome": "reject"}))

    for case_id, name, relays in [
        ("card-fields-basic", "Tali's Claude", ["wss://relay.example.com", "wss://nos.example.org"]),
        ("card-fields-relay-order", "Tali's Claude", ["wss://nos.example.org", "wss://relay.example.com"]),
        ("card-fields-unicode", "Ågent \U0001f916", []),
        ("card-fields-not-normalised", "Ågent \U0001f916", ["wss://rélay.example"]),
    ]:
        name_hash, relays_hash = card_hashes(name, relays)
        cases.append(
            v.case(
                case_id,
                "04 §2.4 nameHash = keccak256(utf8(name)), relaysHash = keccak256(JCS(relays)); no Unicode normalisation, relay order kept",
                {"op": "cardHashes", "name": name, "relays": relays},
                {"nameHash": name_hash, "relaysHash": relays_hash},
            )
        )

    owner_secret = v.det("eip712/basic/owner/evm", 32)
    agent_secret = v.det("eip712/basic/agent/evm", 32)
    sig = card_sig(owner_secret, card_digest(card))
    if not verify_card_sig(card, sig):
        v.fail("the card signature does not verify")
    cases.append(
        v.case(
            "card-sign",
            "04 §2.4 cardSig: owner EVM key, EIP-712, RFC 6979, low s, 0x + 130 hex with v in {27, 28} (04 §2.4.1)",
            {"op": "signAgentCard", "card": card, "secretKey": owner_secret.hex()},
            {"cardSig": sig},
        )
    )

    def verify_case(case_id, why, the_card, the_sig, accept):
        if verify_card_sig(the_card, the_sig) != accept:
            v.fail(f"{case_id}: unexpected verification result")
        cases.append(
            v.case(
                case_id,
                f"04 §2.4: {why}",
                {"op": "verifyAgentCard", "card": the_card, "cardSig": the_sig},
                {"outcome": "accept" if accept else "reject"},
            )
        )

    verify_case("card-verify", "the owner's signature verifies for card.ownerEvm", card, sig, True)
    verify_case("card-verify-reject-field-changed", "keyEpoch changed after signing", card_variant(keyEpoch=1), sig, False)
    with_chain = {"name": "OCC AgentCard", "version": "1", "chainId": 1}
    chain_fields = [*AGENT_CARD_TYPES["EIP712Domain"], {"name": "chainId", "type": "uint256"}]
    verify_case("card-verify-reject-chain-domain", "signed under a domain that adds chainId 1 (the card domain is chain-agnostic)", card, card_sig(owner_secret, card_digest(card, with_chain, chain_fields)), False)
    verify_case("card-verify-reject-occ-domain", "signed under {name: \"OCC\", version: \"2\"}", card, card_sig(owner_secret, card_digest(card, {"name": "OCC", "version": "2"})), False)
    verify_case("card-verify-reject-other-key", "signed by another key", card, card_sig(v.det("eip712/other/evm", 32), card_digest(card)), False)
    verify_case("card-verify-reject-agent-sig", "the agent's own signature (cardAgentSig) is not the owner's", card, card_sig(agent_secret, card_digest(card)), False)
    r_hex, s_hex, v_byte = sig[2:66], sig[66:130], int(sig[130:132], 16)
    high_s = format(v.SECP256K1_N - int(s_hex, 16), "064x")
    high_s_sig = "0x" + r_hex + high_s + format(55 - v_byte, "02x")  # the same signer, malleated
    if recover(card_digest(card), r_hex, high_s, 55 - v_byte - 27) != card["ownerEvm"]:
        v.fail("the malleated signature does not recover the owner")
    verify_case("card-verify-reject-high-s", "the malleated high-s form of a valid signature (EIP-2)", card, high_s_sig, False)
    verify_case("card-verify-reject-v-0-1", "v as a recovery id (0 or 1) instead of 27 or 28", card, sig[:130] + format(v_byte - 27, "02x"), False)
    verify_case("card-verify-reject-64-bytes", "r || s without v (64 bytes)", card, sig[:130], False)
    verify_case("card-verify-reject-uppercase", "cardSig in upper-case hex", card, "0x" + sig[2:].upper(), False)
    verify_case("card-verify-reject-no-prefix", "cardSig without 0x", card, sig[2:], False)
    n_hex = format(v.SECP256K1_N, "064x")
    verify_case("card-verify-reject-r-zero", "r = 0 (r must be in [1, n - 1])", card, "0x" + "00" * 32 + s_hex + format(v_byte, "02x"), False)
    verify_case("card-verify-reject-s-zero", "s = 0 (s must be in [1, n - 1])", card, "0x" + r_hex + "00" * 32 + format(v_byte, "02x"), False)
    verify_case("card-verify-reject-r-n", "r = n (r must be in [1, n - 1])", card, "0x" + n_hex + s_hex + format(v_byte, "02x"), False)
    verify_case("card-verify-reject-v-29", "v = 29", card, sig[:130] + "1d", False)

    # cardAgentSig (04 §2.9): the agent EVM key's signature over the same card digest; it must recover
    # card.agentEvm. A signature by the owner key in its place is rejected.
    agent_sig = card_sig(agent_secret, card_digest(card))
    if not verify_card_sig(card, agent_sig, "agentEvm"):
        v.fail("cardAgentSig does not verify")
    cases.append(
        v.case(
            "card-agent-sign",
            "04 §2.9 cardAgentSig: the agent EVM key over the same AgentCard digest as cardSig (canonical ECDSA, 04 §2.4.1)",
            {"op": "signCardAgent", "card": card, "secretKey": agent_secret.hex()},
            {"cardAgentSig": agent_sig},
        )
    )

    def agent_case(case_id, why, the_card, the_sig, accept):
        if verify_card_sig(the_card, the_sig, "agentEvm") != accept:
            v.fail(f"{case_id}: unexpected verification result")
        cases.append(
            v.case(
                case_id,
                f"04 §2.9: {why}",
                {"op": "verifyCardAgentSig", "card": the_card, "cardAgentSig": the_sig},
                {"outcome": "accept" if accept else "reject"},
            )
        )

    agent_case("card-agent-verify", "cardAgentSig recovers card.agentEvm", card, agent_sig, True)
    agent_case("card-agent-verify-reject-owner-sig", "the owner's cardSig in place of cardAgentSig", card, sig, False)
    agent_case("card-agent-verify-reject-other-card", "a cardAgentSig over another card (keyEpoch changed)", card_variant(keyEpoch=1), agent_sig, False)
    agent_r, agent_s, agent_v = agent_sig[2:66], agent_sig[66:130], int(agent_sig[130:132], 16)
    agent_high = "0x" + agent_r + format(v.SECP256K1_N - int(agent_s, 16), "064x") + format(55 - agent_v, "02x")
    agent_case("card-agent-verify-reject-high-s", "the malleated high-s form (EIP-2)", card, agent_high, False)

    # Raw JSON text of a card (04 §2.4: I-JSON; §2.4.1: integer tokens match 0|[1-9][0-9]*).
    canonical_text = json.dumps(card)
    cases.append(
        v.case(
            "card-json-canonical",
            f"{CARD_FORM}: the card as JSON text parses and hashes like the object",
            {"op": "agentCardJson", "json": canonical_text},
            {"digest": card_digest(parse_card_text(canonical_text)).hex()},
        )
    )
    for case_id, why, text in [
        ("duplicate-key", "a duplicate key (I-JSON)", canonical_text[:-1] + ', "keyEpoch": 0}'),
        ("version-1-0", "version spelled 1.0", canonical_text.replace('"version": 1,', '"version": 1.0,')),
        ("issued-at-exponent", "issuedAt spelled 1.76e9", canonical_text.replace('"issuedAt": 1760000000', '"issuedAt": 1.76e9')),
        ("expires-at-fraction", "expiresAt spelled 1791536000.0", canonical_text.replace('"expiresAt": 1791536000', '"expiresAt": 1791536000.0')),
        ("key-epoch-minus-zero", "keyEpoch spelled -0", canonical_text.replace('"keyEpoch": 0', '"keyEpoch": -0')),
        ("issued-at-near-integer", "issuedAt spelled 9007199254740991.4", canonical_text.replace('"issuedAt": 1760000000', '"issuedAt": 9007199254740991.4')),
    ]:
        if text == canonical_text:
            v.fail(f"{case_id}: substitution did not apply")
        try:
            parse_card_text(text)
            v.fail(f"{case_id} parses")
        except ValueError:
            pass
        cases.append(v.case(f"card-json-reject-{case_id}", f"{CARD_FORM}: {why}; rejected on the token, never normalised", {"op": "agentCardJson", "json": text}, {"outcome": "reject"}))
    return cases


BYTES32 = {"type": "string", "pattern": "^0x[0-9a-f]{64}$"}
SIGNATURE_0X = {"type": "string", "pattern": "^0x[0-9a-f]{130}$"}
SCHEMA = v.case_schema(
    SUITE,
    "EIP-712. `typedData`: domain separator, hashStruct(message) and digest of full typed data. "
    "`signTypedData`, `signAgentCard`: deterministic ECDSA as 0x + r || s || v (v 27 or 28). "
    "`agentCard`: typeHash, domain separator, struct hash and digest of a card in the card JSON "
    "form under the chain-agnostic domain, or a rejection of a non-canonical card. `cardHashes`: "
    "nameHash and relaysHash. `verifyAgentCard`: whether `cardSig` is the card owner's. `signCardAgent` / "
    "`verifyCardAgentSig`: the agent key's cardAgentSig and whether it recovers agentEvm. Hashes are "
    "32-byte hex without 0x. `agentCardJson`: the digest of a card given as JSON text, or a "
    "rejection of a duplicate key or a non-canonical integer token.",
    {
        "typedData": ({"typedData": v.OBJECT}, [{"domainSeparator": v.hexn(32), "structHash": v.hexn(32), "digest": v.hexn(32)}]),
        "signTypedData": ({"typedData": v.OBJECT, "secretKey": v.hexn(32)}, [{"signature": SIGNATURE_0X}]),
        "agentCard": (
            {"card": v.OBJECT},
            [{"typeHash": v.hexn(32), "domainSeparator": v.hexn(32), "structHash": v.hexn(32), "digest": v.hexn(32)}, v.REJECT],
        ),
        "agentCardJson": ({"json": v.STRING}, [{"digest": v.hexn(32)}, v.REJECT]),
        "signCardAgent": ({"card": v.OBJECT, "secretKey": v.hexn(32)}, [{"cardAgentSig": SIGNATURE_0X}]),
        "verifyCardAgentSig": ({"card": v.OBJECT, "cardAgentSig": v.STRING}, [v.ACCEPT, v.REJECT]),
        "cardHashes": ({"name": v.STRING, "relays": {"type": "array", "items": v.STRING}}, [{"nameHash": BYTES32, "relaysHash": BYTES32}]),
        "signAgentCard": ({"card": v.OBJECT, "secretKey": v.hexn(32)}, [{"cardSig": SIGNATURE_0X}]),
        "verifyAgentCard": ({"card": v.OBJECT, "cardSig": v.STRING}, [v.ACCEPT, v.REJECT]),
    },
)

if __name__ == "__main__":
    v.main(
        suite=SUITE,
        version=VERSION,
        script="tools/vectors/generate_eip712.py",
        libraries=["cryptography", "coincurve", "pycryptodome", "rfc8785"],
        build=build,
        schema=SCHEMA,
        doc=__doc__,
    )
