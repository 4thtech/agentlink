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
keccak256(utf8(name)); relaysHash = keccak256(JCS(relays)) (RFC 8785, `rfc8785`). In the case
inputs, uint fields are decimal strings (uint64 does not fit a JSON number) and bytes32 fields are
0x-prefixed lowercase hex; this is the vector input convention, not a card wire format.
Signatures are given as r, s (32-byte hex) and yParity (0 or 1). Keys are synthetic test values.

Negative cases: a card signature does not verify for the card's ownerEvm after any field changes,
under a domain that adds chainId, under another domain name or version, by another key, or when
it is the agent's own signature (cardAgentSig, 05 §4).

Usage: python3 -I tools/vectors/generate_eip712.py --check [FILE] | --write
"""

import copy
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


def card_digest(card, domain=AGENT_CARD_DOMAIN, domain_fields=None):
    types = dict(AGENT_CARD_TYPES)
    if domain_fields is not None:
        types["EIP712Domain"] = domain_fields
    return digest(types, "AgentCard", domain, card)


def card_hashes(name, relays):
    return "0x" + v.keccak256(name.encode("utf-8")).hex(), "0x" + v.keccak256(v.jcs(relays)).hex()


def b32(data):
    return "0x" + bytes(data).hex()


def make_card(label, name, relays, issued_at, expires_at, key_epoch):
    name_hash, relays_hash = card_hashes(name, relays)
    return {
        "version": "1",
        "agentEvm": v.evm_address(v.det(f"eip712/{label}/agent/evm", 32)),
        "agentNostr": b32(v.xonly_public_key(v.det(f"eip712/{label}/agent/nostr", 32))),
        "agentEnc": b32(v.x25519_public_key(v.det(f"eip712/{label}/agent/enc", 32))),
        "ownerEvm": v.evm_address(v.det(f"eip712/{label}/owner/evm", 32)),
        "ownerNostr": b32(v.xonly_public_key(v.det(f"eip712/{label}/owner/nostr", 32))),
        "ownerEnc": b32(v.x25519_public_key(v.det(f"eip712/{label}/owner/enc", 32))),
        "nameHash": name_hash,
        "relaysHash": relays_hash,
        "issuedAt": str(issued_at),
        "expiresAt": str(expires_at),
        "keyEpoch": str(key_epoch),
    }


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
            f"{EXAMPLE}: signature by keccak256(\"cow\"), v = 28 (published)",
            {"op": "signTypedData", "typedData": MAIL, "secretKey": cow.hex()},
            {"r": p["r"], "s": p["s"], "yParity": str(p["v"] - 27)},
        ),
    ]

    cards = [
        ("card-basic", make_card("basic", "Tali's Claude", ["wss://relay.example.com", "wss://nos.example.org"], 1760000000, 1791536000, 0)),
        ("card-no-expiry", make_card("no-expiry", "Research agent", ["wss://relay.example.com"], 1760000000, 0, 3)),
        ("card-limits", make_card("limits", "Ågent \U0001f916", [], 2**64 - 1, 2**64 - 1, 2**32 - 1)),
    ]
    for case_id, card in cards:
        cases.append(
            v.case(
                f"{case_id}-hashes",
                "04 §2.4 AgentCard, chain-agnostic domain {name: \"OCC AgentCard\", version: \"1\"}",
                {"op": "agentCard", "card": card},
                {
                    "typeHash": type_hash(AGENT_CARD_TYPES, "AgentCard").hex(),
                    "domainSeparator": hash_struct(AGENT_CARD_TYPES, "EIP712Domain", AGENT_CARD_DOMAIN).hex(),
                    "structHash": hash_struct(AGENT_CARD_TYPES, "AgentCard", card).hex(),
                    "digest": card_digest(card).hex(),
                },
            )
        )

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

    card = cards[0][1]
    owner_secret = v.det("eip712/basic/owner/evm", 32)
    agent_secret = v.det("eip712/basic/agent/evm", 32)
    r, s, y = ecdsa_sign(owner_secret, card_digest(card))
    if recover(card_digest(card), r, s, y) != card["ownerEvm"]:
        v.fail("the card signature does not recover the owner")
    cases.append(
        v.case(
            "card-sign",
            "04 §2.4 cardSig: owner EVM key, EIP-712 (RFC 6979, low s)",
            {"op": "signAgentCard", "card": card, "secretKey": owner_secret.hex()},
            {"r": r, "s": s, "yParity": str(y)},
        )
    )

    def verify_case(case_id, why, the_card, sig, accept):
        if (recover(card_digest(the_card), *sig) == the_card["ownerEvm"]) != accept:
            v.fail(f"{case_id}: unexpected verification result")
        cases.append(
            v.case(
                case_id,
                f"04 §2.4: {why}",
                {"op": "verifyAgentCard", "card": the_card, "r": sig[0], "s": sig[1], "yParity": sig[2]},
                {"outcome": "accept" if accept else "reject"},
            )
        )

    verify_case("card-verify", "the owner's signature verifies for card.ownerEvm", card, (r, s, y), True)
    bumped = copy.deepcopy(card)
    bumped["keyEpoch"] = "1"
    verify_case("card-verify-reject-field-changed", "keyEpoch changed after signing", bumped, (r, s, y), False)
    with_chain = {"name": "OCC AgentCard", "version": "1", "chainId": 1}
    chain_fields = [*AGENT_CARD_TYPES["EIP712Domain"], {"name": "chainId", "type": "uint256"}]
    verify_case(
        "card-verify-reject-chain-domain",
        "signed under a domain that adds chainId 1 (the card domain is chain-agnostic)",
        card,
        ecdsa_sign(owner_secret, card_digest(card, with_chain, chain_fields)),
        False,
    )
    verify_case(
        "card-verify-reject-occ-domain",
        "signed under {name: \"OCC\", version: \"2\"}",
        card,
        ecdsa_sign(owner_secret, card_digest(card, {"name": "OCC", "version": "2"})),
        False,
    )
    verify_case("card-verify-reject-other-key", "signed by another key", card, ecdsa_sign(v.det("eip712/other/evm", 32), card_digest(card)), False)
    verify_case("card-verify-reject-agent-sig", "the agent's own signature (cardAgentSig) is not the owner's", card, ecdsa_sign(agent_secret, card_digest(card)), False)
    return cases


UINT_STRING = {"type": "string", "pattern": "^(0|[1-9][0-9]*)$"}
BYTES32 = {"type": "string", "pattern": "^0x[0-9a-f]{64}$"}
CARD = v.strict_object(
    {
        "version": UINT_STRING,
        "agentEvm": v.ADDRESS,
        "agentNostr": BYTES32,
        "agentEnc": BYTES32,
        "ownerEvm": v.ADDRESS,
        "ownerNostr": BYTES32,
        "ownerEnc": BYTES32,
        "nameHash": BYTES32,
        "relaysHash": BYTES32,
        "issuedAt": UINT_STRING,
        "expiresAt": UINT_STRING,
        "keyEpoch": UINT_STRING,
    }
)
SIGNATURE = {"r": v.hexn(32), "s": v.hexn(32), "yParity": {"enum": ["0", "1"]}}
SCHEMA = v.case_schema(
    SUITE,
    "EIP-712. `typedData`: domain separator, hashStruct(message) and digest of full typed data. "
    "`signTypedData`, `signAgentCard`: deterministic ECDSA r, s, yParity. `agentCard`: typeHash, "
    "domain separator, struct hash and digest of an AgentCard under the chain-agnostic domain. "
    "`cardHashes`: nameHash and relaysHash. `verifyAgentCard`: whether the signature is the "
    "card owner's. Hashes are 32-byte hex without 0x.",
    {
        "typedData": ({"typedData": v.OBJECT}, [{"domainSeparator": v.hexn(32), "structHash": v.hexn(32), "digest": v.hexn(32)}]),
        "signTypedData": ({"typedData": v.OBJECT, "secretKey": v.hexn(32)}, [SIGNATURE]),
        "agentCard": (
            {"card": CARD},
            [{"typeHash": v.hexn(32), "domainSeparator": v.hexn(32), "structHash": v.hexn(32), "digest": v.hexn(32)}],
        ),
        "cardHashes": ({"name": v.STRING, "relays": {"type": "array", "items": v.STRING}}, [{"nameHash": BYTES32, "relaysHash": BYTES32}]),
        "signAgentCard": ({"card": CARD, "secretKey": v.hexn(32)}, [SIGNATURE]),
        "verifyAgentCard": (
            {"card": CARD, "r": v.hexn(32), "s": v.hexn(32), "yParity": v.INTEGER},
            [v.ACCEPT, v.REJECT],
        ),
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
