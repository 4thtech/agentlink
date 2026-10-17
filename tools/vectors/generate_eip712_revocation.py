#!/usr/bin/env python3
"""Independent generator for the `eip712-revocation` suite: EIP-712 hashing of the OCCRegistry
`Revocation` struct (05 §4, D-81; M1-1i-b; the code under test is M1-1j).

The EIP-712 encoding (encodeType, typeHash, hashStruct, domain separator and
digest = keccak256(0x1901 || domainSeparator || hashStruct(message))) is the one of the `eip712`
generator (generate_eip712.py: Keccak-256 from pycryptodome, static types only). Before writing
anything this generator reproduces the official EIP-712 "Ether Mail" example through it again,
including the four-field domain {name, version, chainId, verifyingContract}.

Types, with the field order of the spec:
- `Revocation { address agentEvm; uint32 keyEpoch; uint256 nonce; uint64 deadline; }` (05 §4,
  D-81), signed by `ownerEvm` under the OCC v2 chain domain {name: "OCC", version: "2", chainId,
  verifyingContract}; `verifyingContract` is the Registry, the contract that verifies `ownerSig`
  (as for `Registration` in the `eip712-proof` suite).
- `Registration` (05 §4), only for the shared-nonce cases: `Registration` and `Revocation` nonces
  are random and single-use per owner, tracked in one `usedNonces[ownerEvm][nonce]` (D-81). Single
  use is contract state (M2-4a); a hash cannot show it. The cases show that one nonce under the two
  types gives distinct type hashes, struct hashes and digests, so one signature never serves both.
  `cardHash` is a given bytes32, as in `eip712-proof`.

04 §2.4.1 lists no `Revocation` paths. Its messages use the 05 §3.1 JSON form of the other proof
types (derived here, flagged in the PR): `agentEvm` is 0x + 40 lowercase hex; `nonce` is a decimal
string matching ^(0|[1-9][0-9]*)$ up to 2^256 - 1; `keyEpoch` (as in the card JSON form, 04 §2.4)
and `deadline` are JSON integers in [0, 2^53 - 1] within their uint type. Every non-canonical form
is rejected, never normalised. All addresses, hashes and nonces are synthetic test values
(vectorlib.det); the chain IDs are Base Sepolia (84532) and Gnosis Chiado (10200). No signatures:
the card scope is hashing only.

Usage: python3 -I tools/vectors/generate_eip712_revocation.py --check [FILE] | --write
"""

import copy
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import generate_eip712 as e  # noqa: E402
import vectorlib as v  # noqa: E402

SUITE = "eip712-revocation"
VERSION = 1

DOMAIN_FIELDS = [
    {"name": "name", "type": "string"},
    {"name": "version", "type": "string"},
    {"name": "chainId", "type": "uint256"},
    {"name": "verifyingContract", "type": "address"},
]
TYPES = {
    "EIP712Domain": DOMAIN_FIELDS,
    "Revocation": [
        {"name": "agentEvm", "type": "address"},
        {"name": "keyEpoch", "type": "uint32"},
        {"name": "nonce", "type": "uint256"},
        {"name": "deadline", "type": "uint64"},
    ],
    "Registration": [
        {"name": "cardHash", "type": "bytes32"},
        {"name": "feeToken", "type": "address"},
        {"name": "maxFee", "type": "uint256"},
        {"name": "appId", "type": "bytes32"},
        {"name": "nonce", "type": "uint256"},
        {"name": "deadline", "type": "uint64"},
    ],
}
SOURCES = {
    "Revocation": "05 §4 Revocation (D-81), signed by ownerEvm; OCC v2 chain domain {name: \"OCC\", version: \"2\", chainId, verifyingContract = the Registry}",
    "Registration": "05 §4 Registration (regOwnerSig); OCC v2 chain domain with the Registry as verifyingContract",
}
NONCE_RULE = "05 §4 (D-81): Registration and Revocation nonces are single-use per owner in one usedNonces[ownerEvm][nonce]; one nonce under the two types gives distinct digests"
JSON_FORM = "05 §3.1 JSON form applied to Revocation (04 §2.4.1; derived)"
UINT256_MAX = 2**256 - 1
UINT32_MAX = 2**32 - 1
SAFE_MAX = 2**53 - 1
ZERO32 = "0x" + "00" * 32
ZERO_ADDRESS = "0x" + "00" * 20


def addr(label):
    return "0x" + v.det(f"eip712-revocation/{label}", 20).hex()


def b32(label):
    return "0x" + v.det(f"eip712-revocation/{label}", 32).hex()


def uint256_text(label):
    return str(int.from_bytes(v.det(f"eip712-revocation/{label}", 32), "big"))


def domain(chain_id, contract):
    return {"name": "OCC", "version": "2", "chainId": chain_id, "verifyingContract": contract}


BASE_SEPOLIA = 84532
CHIADO = 10200
REGISTRY = addr("registry")
USDC = addr("fee-token")


def parse_message(primary, message):
    """The JSON form: exactly the struct's fields; addresses 0x + 40 lowercase hex; bytes32 0x + 64
    lowercase hex; uint256 as a canonical decimal string up to 2^256 - 1; other integers as JSON
    integers in [0, 2^53 - 1] within their type."""
    fields = TYPES[primary]
    if not isinstance(message, dict) or set(message) != {f["name"] for f in fields}:
        raise ValueError("not exactly the struct's fields")
    for field in fields:
        name, kind, value = field["name"], field["type"], message[field["name"]]
        if kind == "address":
            if not isinstance(value, str) or not re.fullmatch(r"0x[0-9a-f]{40}", value):
                raise ValueError(f"{name} is not canonical")
        elif kind == "bytes32":
            if not isinstance(value, str) or not re.fullmatch(r"0x[0-9a-f]{64}", value):
                raise ValueError(f"{name} is not canonical")
        elif kind == "uint256":
            if not isinstance(value, str) or not re.fullmatch(r"0|[1-9][0-9]*", value) or int(value) > UINT256_MAX:
                raise ValueError(f"{name} is not a canonical uint256 decimal string")
        else:
            bits = int(re.fullmatch(r"uint(\d+)", kind).group(1))
            if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= min(SAFE_MAX, 2**bits - 1):
                raise ValueError(f"{name} is out of range")
    return message


def hashes(primary, the_domain, message):
    parse_message(primary, message)
    return {
        "typeHash": e.type_hash(TYPES, primary).hex(),
        "domainSeparator": e.hash_struct(TYPES, "EIP712Domain", the_domain).hex(),
        "structHash": e.hash_struct(TYPES, primary, message).hex(),
        "digest": e.digest(TYPES, primary, the_domain, message).hex(),
    }


def self_check():
    mail, p = e.MAIL, e.MAIL_PUBLISHED
    if mail["types"]["EIP712Domain"] != DOMAIN_FIELDS:
        v.fail("the Ether Mail domain fields differ from the OCC v2 domain fields")
    lowered = mail["domain"] | {"verifyingContract": mail["domain"]["verifyingContract"].lower()}
    if e.hash_struct(TYPES, "EIP712Domain", lowered).hex() != p["domainSeparator"]:
        v.fail("the four-field domain separator differs from Example.js")
    if e.digest(mail["types"], "Mail", mail["domain"], mail["message"]).hex() != p["digest"]:
        v.fail("the EIP-712 digest differs from Example.js")
    expected_types = {
        "Revocation": "Revocation(address agentEvm,uint32 keyEpoch,uint256 nonce,uint64 deadline)",
        "Registration": "Registration(bytes32 cardHash,address feeToken,uint256 maxFee,bytes32 appId,uint256 nonce,uint64 deadline)",
        "EIP712Domain": "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
    }
    for primary, text in expected_types.items():
        if e.encode_type(TYPES, primary) != text:
            v.fail(f"encodeType({primary}) is not the 05 §4 struct")


def build():
    self_check()
    cases = []
    registry = domain(BASE_SEPOLIA, REGISTRY)
    agent = addr("agent")
    revocation = {"agentEvm": agent, "keyEpoch": 0, "nonce": uint256_text("revocation/nonce"), "deadline": 1760003600}
    for case_id, why, the_domain, rev in [
        ("revocation-basic", "an agent at keyEpoch 0, a random nonce", registry, revocation),
        ("revocation-epoch-3", "the same agent at keyEpoch 3 (the stored epoch after three rotations)", registry, revocation | {"keyEpoch": 3}),
        ("revocation-chiado", "the same Revocation under Gnosis Chiado (another chainId)", domain(CHIADO, REGISTRY), revocation),
        ("revocation-other-registry", "the same Revocation under another verifyingContract", domain(BASE_SEPOLIA, addr("other-registry")), revocation),
        ("revocation-other-nonce", "the same agent and epoch with a fresh nonce", registry, revocation | {"nonce": uint256_text("revocation/nonce-2")}),
        ("revocation-zero", "keyEpoch 0, nonce \"0\", deadline 0, agentEvm address(0) (encoding edges)", registry, {"agentEvm": ZERO_ADDRESS, "keyEpoch": 0, "nonce": "0", "deadline": 0}),
        ("revocation-limits", "agentEvm 0xff…ff, keyEpoch 2^32 - 1, nonce 2^256 - 1, deadline 2^53 - 1", registry, {"agentEvm": "0x" + "ff" * 20, "keyEpoch": UINT32_MAX, "nonce": str(UINT256_MAX), "deadline": SAFE_MAX}),
    ]:
        cases.append(v.case(case_id, f"{SOURCES['Revocation']}; {why}", {"op": "revocation", "domain": the_domain, "revocation": rev}, hashes("Revocation", the_domain, rev)))
    if len({c["expected"]["digest"] for c in cases}) != len(cases):
        v.fail("two Revocation cases have the same digest")

    shared = uint256_text("owner/shared-nonce")
    registration = {"cardHash": b32("registration/card-hash"), "feeToken": USDC, "maxFee": "1000000", "appId": ZERO32, "nonce": shared, "deadline": 1760003600}
    rev_shared = revocation | {"nonce": shared}
    reg_case = v.case("nonce-shared-registration", f"{SOURCES['Registration']}; {NONCE_RULE}: the Registration", {"op": "registration", "domain": registry, "registration": registration}, hashes("Registration", registry, registration))
    rev_case = v.case("nonce-shared-revocation", f"{SOURCES['Revocation']}; {NONCE_RULE}: the Revocation with the same nonce and deadline", {"op": "revocation", "domain": registry, "revocation": rev_shared}, hashes("Revocation", registry, rev_shared))
    for field in ("typeHash", "structHash", "digest"):
        if reg_case["expected"][field] == rev_case["expected"][field]:
            v.fail(f"the shared-nonce Registration and Revocation have the same {field}")
    cases += [reg_case, rev_case]

    def variant(message, **changes):
        out = copy.deepcopy(message)
        for key_name, value in changes.items():
            if value is None:
                del out[key_name]
            else:
                out[key_name] = value
        return out

    rev = revocation
    rejects = [
        ("agent-checksummed", "agentEvm in EIP-55 mixed case", variant(rev, agentEvm=v.eip55(rev["agentEvm"]))),
        ("agent-uppercase", "agentEvm in upper-case hex", variant(rev, agentEvm="0x" + rev["agentEvm"][2:].upper())),
        ("agent-no-prefix", "agentEvm without 0x", variant(rev, agentEvm=rev["agentEvm"][2:])),
        ("agent-capital-prefix", "agentEvm with 0X", variant(rev, agentEvm="0X" + rev["agentEvm"][2:])),
        ("agent-19-bytes", "agentEvm of 19 bytes", variant(rev, agentEvm=rev["agentEvm"][:-2])),
        ("agent-32-bytes", "agentEvm left-padded to 32 bytes (the ABI word)", variant(rev, agentEvm="0x" + "00" * 12 + rev["agentEvm"][2:])),
        ("key-epoch-2-pow-32", "keyEpoch = 2^32 (outside uint32)", variant(rev, keyEpoch=2**32)),
        ("key-epoch-negative", "keyEpoch = -1", variant(rev, keyEpoch=-1)),
        ("key-epoch-string", "keyEpoch as a decimal string", variant(rev, keyEpoch="0")),
        ("key-epoch-boolean", "keyEpoch as false", variant(rev, keyEpoch=False)),
        ("key-epoch-fraction", "keyEpoch = 1.5", variant(rev, keyEpoch=1.5)),
        ("nonce-number", "nonce as a JSON number", variant(rev, nonce=12345)),
        ("nonce-leading-zero", "nonce with a leading zero", variant(rev, nonce="0" + rev["nonce"])),
        ("nonce-sign", "nonce with a + sign", variant(rev, nonce="+" + rev["nonce"])),
        ("nonce-negative", "nonce \"-1\"", variant(rev, nonce="-1")),
        ("nonce-hex", "nonce as 0x hex", variant(rev, nonce=hex(int(rev["nonce"])))),
        ("nonce-2-pow-256", "nonce = 2^256 (above uint256)", variant(rev, nonce=str(2**256))),
        ("nonce-empty", "nonce \"\"", variant(rev, nonce="")),
        ("nonce-whitespace", "nonce with a trailing space", variant(rev, nonce=rev["nonce"] + " ")),
        ("deadline-2-pow-53", "deadline = 2^53 (uint64 above 2^53 - 1)", variant(rev, deadline=2**53)),
        ("deadline-negative", "deadline = -1", variant(rev, deadline=-1)),
        ("deadline-string", "deadline as a decimal string", variant(rev, deadline="1760003600")),
        ("unknown-field", "a fifth field ownerEvm", variant(rev, ownerEvm=addr("owner"))),
        ("missing-field", "keyEpoch missing", variant(rev, keyEpoch=None)),
        ("registration-shape", "a Registration message in place of a Revocation", registration),
    ]
    for case_id, why, bad in rejects:
        try:
            parse_message("Revocation", bad)
            v.fail(f"revocation {case_id} parses")
        except ValueError:
            pass
        cases.append(v.case(f"revocation-reject-{case_id}", f"{JSON_FORM}: {why}; rejected, never normalised", {"op": "revocation", "domain": registry, "revocation": bad}, {"outcome": "reject"}))
    return cases


HASHES = {"typeHash": v.hexn(32), "domainSeparator": v.hexn(32), "structHash": v.hexn(32), "digest": v.hexn(32)}
SCHEMA = v.case_schema(
    SUITE,
    "EIP-712 hashing of the OCCRegistry Revocation struct (05 §4, D-81). `revocation`: typeHash, "
    "domain separator, struct hash and digest (32-byte hex without 0x) of a Revocation in its JSON "
    "form under a domain {name, version, chainId, verifyingContract}, or a rejection of a "
    "non-canonical Revocation. `registration`: the same hashes of a Registration that shares its "
    "owner nonce with a Revocation.",
    {
        "revocation": ({"domain": v.OBJECT, "revocation": v.OBJECT}, [HASHES, v.REJECT]),
        "registration": ({"domain": v.OBJECT, "registration": v.OBJECT}, [HASHES]),
    },
)

if __name__ == "__main__":
    v.main(
        suite=SUITE,
        version=VERSION,
        script="tools/vectors/generate_eip712_revocation.py",
        libraries=["pycryptodome"],
        build=build,
        schema=SCHEMA,
        doc=__doc__,
    )
