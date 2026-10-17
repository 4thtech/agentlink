#!/usr/bin/env python3
"""Independent generator for the `eip712-proof` suite: EIP-712 hashing of the OCC v2 proof types
(M1-1i; the code under test is M1-1j).

The EIP-712 encoding (encodeType, typeHash, hashStruct, domain separator and
digest = keccak256(0x1901 || domainSeparator || hashStruct(message))) is the one of the `eip712`
generator (generate_eip712.py: Keccak-256 from pycryptodome, static types only). Before writing
anything this generator reproduces the official EIP-712 "Ether Mail" example through it again,
including the four-field domain {name, version, chainId, verifyingContract} the proof types use.

Types, with the field order of the spec:
- `Record` and `Receipt` (05 §3.1; 04 §5) under the OCC v2 chain domain
  {name: "OCC", version: "2", chainId, verifyingContract = the Notary}.
- `Registration` (05 §4) under the same "OCC v2 chain-specific domain"; here `verifyingContract` is
  the Registry, the contract that verifies `regOwnerSig`. `cardHash` is taken as a given bytes32:
  05 §4 calls it the "EIP-712 hash of the AgentCard" without saying struct hash or digest, so no
  case derives it from a card. G-20 leaves the `Registration` nonce rules open; hashing does not
  depend on them, and the revoke struct waits for G-20 (M1-1i-b).
- The recipient commitment keccak256(abi.encode(recipientAgentEvm, salt)) (04 §5; 05 §3.1).

Record and Receipt messages are in their 05 §3.1 JSON form (04 §2.4.1): addresses and bytes32 are
0x + lowercase hex, `maxFee` and `nonce` are decimal strings matching ^(0|[1-9][0-9]*)$ up to
2^256 - 1, and the other integers are JSON integers in [0, 2^53 - 1] within their uint type. Every
non-canonical form is rejected, never normalised. 04 §2.4.1 does not list `Registration` paths
yet, so its cases use the same form and have no rejections. Domains are inputs as
{name, version, chainId (JSON integer), verifyingContract}. All addresses, hashes, salts and
nonces are synthetic test values (vectorlib.det); the chain IDs are Base Sepolia (84532) and
Gnosis Chiado (10200). No signatures: the card scope is hashing only.

Usage: python3 -I tools/vectors/generate_eip712_proof.py --check [FILE] | --write
"""

import copy
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import generate_eip712 as e  # noqa: E402
import vectorlib as v  # noqa: E402

SUITE = "eip712-proof"
VERSION = 1

DOMAIN_FIELDS = [
    {"name": "name", "type": "string"},
    {"name": "version", "type": "string"},
    {"name": "chainId", "type": "uint256"},
    {"name": "verifyingContract", "type": "address"},
]
TYPES = {
    "EIP712Domain": DOMAIN_FIELDS,
    "Record": [
        {"name": "signer", "type": "address"},
        {"name": "envelopeHash", "type": "bytes32"},
        {"name": "recipientCommitment", "type": "bytes32"},
        {"name": "parentRecordId", "type": "bytes32"},
        {"name": "appId", "type": "bytes32"},
        {"name": "kind", "type": "uint8"},
        {"name": "feeToken", "type": "address"},
        {"name": "maxFee", "type": "uint256"},
        {"name": "nonce", "type": "uint256"},
        {"name": "deadline", "type": "uint64"},
    ],
    "Receipt": [
        {"name": "signer", "type": "address"},
        {"name": "recordId", "type": "bytes32"},
        {"name": "receiptType", "type": "uint8"},
        {"name": "salt", "type": "bytes32"},
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
    "Record": "05 §3.1 Record; 04 §5; OCC v2 chain domain {name: \"OCC\", version: \"2\", chainId, verifyingContract}",
    "Receipt": "05 §3.1 Receipt; 04 §5; OCC v2 chain domain {name: \"OCC\", version: \"2\", chainId, verifyingContract}",
    "Registration": "05 §4 Registration (regOwnerSig); OCC v2 chain-specific domain with the Registry as verifyingContract; nonce rules open (G-20)",
}
JSON_FORM = "05 §3.1 JSON form, 04 §2.4.1"
UINT256_MAX = 2**256 - 1
SAFE_MAX = 2**53 - 1
ZERO32 = "0x" + "00" * 32
ZERO_ADDRESS = "0x" + "00" * 20


def addr(label):
    return "0x" + v.det(f"eip712-proof/{label}", 20).hex()


def b32(label):
    return "0x" + v.det(f"eip712-proof/{label}", 32).hex()


def uint256_text(label):
    return str(int.from_bytes(v.det(f"eip712-proof/{label}", 32), "big"))


def domain(chain_id, contract):
    return {"name": "OCC", "version": "2", "chainId": chain_id, "verifyingContract": contract}


BASE_SEPOLIA = 84532
CHIADO = 10200
NOTARY = addr("notary")
REGISTRY = addr("registry")
USDC = addr("fee-token")


# --- strict JSON form ----------------------------------------------------------------------------


def parse_message(primary, message):
    """The 05 §3.1 JSON form (04 §2.4.1) of a Record, Receipt or Registration: exactly its fields;
    addresses 0x + 40 lowercase hex; bytes32 0x + 64 lowercase hex; uint256 as a canonical decimal
    string up to 2^256 - 1; other integers as JSON integers in [0, 2^53 - 1] within their type."""
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


def recipient_commitment(recipient, salt):
    """keccak256(abi.encode(address, bytes32)): two 32-byte words, the address left-padded."""
    return "0x" + v.keccak256(bytes(12) + bytes.fromhex(recipient[2:]) + bytes.fromhex(salt[2:])).hex()


def record_id(chain_id, notary, signer, nonce):
    """05 §3.3 step 2, only to give the receipts a realistic recordId (not an expected value)."""
    words = chain_id.to_bytes(32, "big") + bytes(12) + bytes.fromhex(notary[2:]) + bytes(12) + bytes.fromhex(signer[2:]) + int(nonce).to_bytes(32, "big")
    return "0x" + v.keccak256(words).hex()


# --- self-checks ---------------------------------------------------------------------------------


def self_check():
    mail, p = e.MAIL, e.MAIL_PUBLISHED
    t = mail["types"]
    if t["EIP712Domain"] != DOMAIN_FIELDS:
        v.fail("the Ether Mail domain fields differ from the OCC v2 domain fields")
    if e.hash_struct(TYPES, "EIP712Domain", mail["domain"] | {"verifyingContract": mail["domain"]["verifyingContract"].lower()}).hex() != p["domainSeparator"]:
        v.fail("the four-field domain separator differs from Example.js")
    if e.digest(t, "Mail", mail["domain"], mail["message"]).hex() != p["digest"]:
        v.fail("the EIP-712 digest differs from Example.js")
    expected_types = {
        "Record": "Record(address signer,bytes32 envelopeHash,bytes32 recipientCommitment,bytes32 parentRecordId,bytes32 appId,uint8 kind,address feeToken,uint256 maxFee,uint256 nonce,uint64 deadline)",
        "Receipt": "Receipt(address signer,bytes32 recordId,uint8 receiptType,bytes32 salt,uint64 deadline)",
        "Registration": "Registration(bytes32 cardHash,address feeToken,uint256 maxFee,bytes32 appId,uint256 nonce,uint64 deadline)",
        "EIP712Domain": "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
    }
    for primary, text in expected_types.items():
        if e.encode_type(TYPES, primary) != text:
            v.fail(f"encodeType({primary}) is not the 05 struct")


# --- cases ---------------------------------------------------------------------------------------


def build():
    self_check()
    cases = []

    recipient = addr("recipient/agent")
    salt = b32("record-message/salt")
    commitment = recipient_commitment(recipient, salt)
    for case_id, why, r, s in [
        ("commitment-basic", "a synthetic recipient agent address and salt", recipient, salt),
        ("commitment-other-salt", "the same recipient with a fresh salt (unlinkable, 04 §5)", recipient, b32("record-reply/salt")),
        ("commitment-zero-salt", "an all-zero salt (an encoding edge, never a real salt)", recipient, ZERO32),
        ("commitment-max-address", "the address 0xff…ff and salt 0xff…ff", "0x" + "ff" * 20, "0x" + "ff" * 32),
    ]:
        cases.append(
            v.case(
                case_id,
                f"04 §5, 05 §3.1: recipientCommitment = keccak256(abi.encode(recipientAgentEvm, salt)); {why}",
                {"op": "recipientCommitment", "recipient": r, "salt": s},
                {"recipientCommitment": recipient_commitment(r, s)},
            )
        )
    if len({c["expected"]["recipientCommitment"] for c in cases}) != len(cases):
        v.fail("two commitments are equal")

    signer = addr("sender/agent")
    message_record = {
        "signer": signer,
        "envelopeHash": b32("record-message/envelope"),
        "recipientCommitment": commitment,
        "parentRecordId": ZERO32,
        "appId": ZERO32,
        "kind": 1,
        "feeToken": USDC,
        "maxFee": "250000",
        "nonce": uint256_text("record-message/nonce"),
        "deadline": 1760003600,
    }
    reply_record = {
        "signer": signer,
        "envelopeHash": b32("record-reply/envelope"),
        "recipientCommitment": recipient_commitment(recipient, b32("record-reply/salt")),
        "parentRecordId": record_id(BASE_SEPOLIA, NOTARY, signer, message_record["nonce"]),
        "appId": b32("integrator/app"),
        "kind": 2,
        "feeToken": ZERO_ADDRESS,
        "maxFee": "0",
        "nonce": "0",
        "deadline": 0,
    }
    note_record = {
        "signer": signer,
        "envelopeHash": b32("record-note/envelope"),
        "recipientCommitment": ZERO32,
        "parentRecordId": ZERO32,
        "appId": ZERO32,
        "kind": 6,
        "feeToken": USDC,
        "maxFee": "1000000",
        "nonce": uint256_text("record-note/nonce"),
        "deadline": 1760007200,
    }
    limits_record = {
        "signer": "0x" + "ff" * 20,
        "envelopeHash": "0x" + "ff" * 32,
        "recipientCommitment": "0x" + "ff" * 32,
        "parentRecordId": "0x" + "ff" * 32,
        "appId": "0x" + "ff" * 32,
        "kind": 255,
        "feeToken": "0x" + "ff" * 20,
        "maxFee": str(UINT256_MAX),
        "nonce": str(UINT256_MAX),
        "deadline": SAFE_MAX,
    }
    base = domain(BASE_SEPOLIA, NOTARY)
    for case_id, why, the_domain, record in [
        ("record-message", "a MESSAGE (kind 1) to one recipient, stablecoin fee", base, message_record),
        ("record-message-chiado", "the same Record under Gnosis Chiado (another chainId: another domain separator and digest)", domain(CHIADO, NOTARY), message_record),
        ("record-message-other-notary", "the same Record under another verifyingContract", domain(BASE_SEPOLIA, addr("other-notary")), message_record),
        ("record-reply-file", "a FILE (kind 2) reply with parentRecordId and appId, native fee token address(0), maxFee \"0\", nonce \"0\", deadline 0", base, reply_record),
        ("record-self-note", "a NOTE (kind 6) to self: recipientCommitment 0", base, note_record),
        ("record-limits", "every field at its maximum: kind 255, maxFee and nonce 2^256 - 1, deadline 2^53 - 1", base, limits_record),
    ]:
        cases.append(v.case(case_id, f"{SOURCES['Record']}; {why}", {"op": "record", "domain": the_domain, "record": record}, hashes("Record", the_domain, record)))
    digests = {c["expected"]["digest"] for c in cases if c["input"]["op"] == "record"}
    if len(digests) != 6:
        v.fail("two Record cases have the same digest")

    recipient_record_id = record_id(BASE_SEPOLIA, NOTARY, signer, message_record["nonce"])
    delivered = {"signer": recipient, "recordId": recipient_record_id, "receiptType": 1, "salt": salt, "deadline": 1760090000}
    receipts = [
        ("receipt-delivered", "DELIVERED (1) by the recipient, with the Record's commitment salt", base, delivered),
        ("receipt-accepted", "ACCEPTED (3): only the type changes", base, delivered | {"receiptType": 3}),
        ("receipt-rejected-chiado", "REJECTED (4) under Gnosis Chiado", domain(CHIADO, NOTARY), delivered | {"receiptType": 4}),
        ("receipt-limits", "receiptType 255, deadline 2^53 - 1, all-ones fields", base, {"signer": "0x" + "ff" * 20, "recordId": "0x" + "ff" * 32, "receiptType": 255, "salt": "0x" + "ff" * 32, "deadline": SAFE_MAX}),
    ]
    for case_id, why, the_domain, receipt in receipts:
        cases.append(v.case(case_id, f"{SOURCES['Receipt']}; {why}", {"op": "receipt", "domain": the_domain, "receipt": receipt}, hashes("Receipt", the_domain, receipt)))

    registry = domain(BASE_SEPOLIA, REGISTRY)
    registration = {
        "cardHash": b32("registration/card-hash"),
        "feeToken": USDC,
        "maxFee": "1000000",
        "appId": ZERO32,
        "nonce": uint256_text("registration/nonce"),
        "deadline": 1760003600,
    }
    for case_id, why, the_domain, reg in [
        ("registration-basic", "stablecoin fee, official client (appId 0)", registry, registration),
        ("registration-app-native", "an integrator appId and the native fee token", registry, registration | {"appId": b32("integrator/app"), "feeToken": ZERO_ADDRESS, "maxFee": "0"}),
        ("registration-chiado", "the same Registration under Gnosis Chiado", domain(CHIADO, REGISTRY), registration),
        ("registration-limits", "maxFee and nonce 2^256 - 1, deadline 2^53 - 1", registry, registration | {"maxFee": str(UINT256_MAX), "nonce": str(UINT256_MAX), "deadline": SAFE_MAX}),
    ]:
        cases.append(v.case(case_id, f"{SOURCES['Registration']}; {why}", {"op": "registration", "domain": the_domain, "registration": reg}, hashes("Registration", the_domain, reg)))

    def variant(message, **changes):
        out = copy.deepcopy(message)
        for key, value in changes.items():
            if value is None:
                del out[key]
            else:
                out[key] = value
        return out

    rec = message_record
    record_rejects = [
        ("max-fee-number", "maxFee as a JSON number", variant(rec, maxFee=250000)),
        ("max-fee-leading-zero", "maxFee \"0250000\" (leading zero)", variant(rec, maxFee="0250000")),
        ("max-fee-sign", "maxFee \"+250000\" (sign)", variant(rec, maxFee="+250000")),
        ("max-fee-negative", "maxFee \"-1\"", variant(rec, maxFee="-1")),
        ("max-fee-fraction", "maxFee \"250000.0\" (fraction)", variant(rec, maxFee="250000.0")),
        ("max-fee-exponent", "maxFee \"2.5e5\" (exponent)", variant(rec, maxFee="2.5e5")),
        ("max-fee-whitespace", "maxFee \" 250000\" (whitespace)", variant(rec, maxFee=" 250000")),
        ("max-fee-empty", "maxFee \"\"", variant(rec, maxFee="")),
        ("nonce-2-pow-256", "nonce = 2^256 (above uint256)", variant(rec, nonce=str(2**256))),
        ("nonce-hex", "nonce as 0x hex", variant(rec, nonce=hex(int(rec["nonce"])))),
        ("signer-checksummed", "signer in EIP-55 mixed case", variant(rec, signer=v.eip55(rec["signer"]))),
        ("signer-no-prefix", "signer without 0x", variant(rec, signer=rec["signer"][2:])),
        ("fee-token-capital-prefix", "feeToken with 0X", variant(rec, feeToken="0X" + rec["feeToken"][2:])),
        ("envelope-hash-uppercase", "envelopeHash in upper-case hex", variant(rec, envelopeHash="0x" + rec["envelopeHash"][2:].upper())),
        ("envelope-hash-bare", "envelopeHash as bare hex (the 04 §3.1 sha256 without 0x)", variant(rec, envelopeHash=rec["envelopeHash"][2:])),
        ("recipient-commitment-31-bytes", "recipientCommitment of 31 bytes", variant(rec, recipientCommitment=rec["recipientCommitment"][:-2])),
        ("parent-record-id-zero-short", "parentRecordId \"0x0\" for zero (must be 32 bytes)", variant(rec, parentRecordId="0x0")),
        ("app-id-base64url", "appId as base64url", variant(rec, appId=v.b64u(bytes(32)))),
        ("kind-256", "kind = 256 (outside uint8)", variant(rec, kind=256)),
        ("kind-string", "kind as a string", variant(rec, kind="1")),
        ("kind-boolean", "kind as true", variant(rec, kind=True)),
        ("deadline-2-pow-53", "deadline = 2^53 (uint64 above 2^53 - 1)", variant(rec, deadline=2**53)),
        ("deadline-negative", "deadline = -1", variant(rec, deadline=-1)),
        ("deadline-string", "deadline as a decimal string", variant(rec, deadline="1760003600")),
        ("unknown-field", "an eleventh field", variant(rec, salt=salt)),
        ("missing-field", "nonce missing", variant(rec, nonce=None)),
    ]
    for case_id, why, bad in record_rejects:
        try:
            parse_message("Record", bad)
            v.fail(f"record {case_id} parses")
        except ValueError:
            pass
        cases.append(v.case(f"record-reject-{case_id}", f"{JSON_FORM}: {why}; rejected, never normalised", {"op": "record", "domain": base, "record": bad}, {"outcome": "reject"}))

    rc = delivered
    receipt_rejects = [
        ("record-id-base64url", "recordId as base64url (04 §2.4.1 cross-class case)", variant(rc, recordId=v.b64u(bytes.fromhex(rc["recordId"][2:])))),
        ("record-id-uppercase", "recordId in upper-case hex", variant(rc, recordId="0x" + rc["recordId"][2:].upper())),
        ("salt-base64url", "salt as base64url (04 §2.4.1 cross-class case)", variant(rc, salt=v.b64u(bytes.fromhex(rc["salt"][2:])))),
        ("salt-33-bytes", "salt of 33 bytes", variant(rc, salt=rc["salt"] + "00")),
        ("signer-checksummed", "signer in EIP-55 mixed case", variant(rc, signer=v.eip55(rc["signer"]))),
        ("receipt-type-256", "receiptType = 256 (outside uint8)", variant(rc, receiptType=256)),
        ("receipt-type-string", "receiptType as a string", variant(rc, receiptType="1")),
        ("deadline-2-pow-53", "deadline = 2^53", variant(rc, deadline=2**53)),
        ("unknown-field", "a sixth field", variant(rc, kind=1)),
        ("missing-field", "salt missing", variant(rc, salt=None)),
    ]
    for case_id, why, bad in receipt_rejects:
        try:
            parse_message("Receipt", bad)
            v.fail(f"receipt {case_id} parses")
        except ValueError:
            pass
        cases.append(v.case(f"receipt-reject-{case_id}", f"{JSON_FORM}: {why}; rejected, never normalised", {"op": "receipt", "domain": base, "receipt": bad}, {"outcome": "reject"}))
    return cases


HASHES = {"typeHash": v.hexn(32), "domainSeparator": v.hexn(32), "structHash": v.hexn(32), "digest": v.hexn(32)}
BYTES32 = {"type": "string", "pattern": "^0x[0-9a-f]{64}$"}
SCHEMA = v.case_schema(
    SUITE,
    "EIP-712 hashing of the OCC v2 proof types (05 §3.1, §4; 04 §5). `record`, `receipt`, "
    "`registration`: typeHash, domain separator, struct hash and digest (32-byte hex without 0x) "
    "of a message in its 05 §3.1 JSON form under a domain {name, version, chainId, "
    "verifyingContract}, or a rejection of a non-canonical Record or Receipt. "
    "`recipientCommitment`: keccak256(abi.encode(recipient, salt)) as 0x + 64 hex.",
    {
        "record": ({"domain": v.OBJECT, "record": v.OBJECT}, [HASHES, v.REJECT]),
        "receipt": ({"domain": v.OBJECT, "receipt": v.OBJECT}, [HASHES, v.REJECT]),
        "registration": ({"domain": v.OBJECT, "registration": v.OBJECT}, [HASHES]),
        "recipientCommitment": ({"recipient": v.ADDRESS, "salt": BYTES32}, [{"recipientCommitment": BYTES32}]),
    },
)

if __name__ == "__main__":
    v.main(
        suite=SUITE,
        version=VERSION,
        script="tools/vectors/generate_eip712_proof.py",
        libraries=["pycryptodome"],
        build=build,
        schema=SCHEMA,
        doc=__doc__,
    )
