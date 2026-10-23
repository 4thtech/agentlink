#!/usr/bin/env python3
"""Independent generator for the `eip3009` suite: the EIP-3009 `ReceiveWithAuthorization` typed data
under a token's own EIP-712 domain, and the check of that domain against what the token reports on
chain (M3-4b-t-1; the code under test is packages/crypto/src/proof-types.ts).

The EIP-712 encoding (encodeType, typeHash, hashStruct, domain separator and
digest = keccak256(0x1901 || domainSeparator || hashStruct(message))) is the one of the `eip712`
generator (generate_eip712.py: Keccak-256 from pycryptodome); signatures are deterministic ECDSA
(RFC 6979, low s) from libsecp256k1 (coincurve), as there.

Only `ReceiveWithAuthorization` exists here (03 §4.4, 05 §2.5: the fee vault pulls the funds with
`receiveWithAuthorization`, which requires `to == msg.sender`, so a front-runner cannot redirect
them). `TransferWithAuthorization` has the same fields and another type hash; it is never built.
The generator refuses to write unless the type hash equals the one Circle's FiatToken reports
(`RECEIVE_WITH_AUTHORIZATION_TYPEHASH()`) and differs from the TransferWithAuthorization one.

The token domain is never hard-coded by the code under test: the caller reads it from chain. The
real values below were read once, read-only, from Base Sepolia (chainId 84532) through the public
RPC https://sepolia.base.org at block 49070689 (0x2ecc261), 2026-10-23, from Circle's USDC at
0x036CbD53842c5426634e7929541eC2318f3dCF7e:
- `eip712Domain()` (EIP-5267): reverts, so the token does not implement it;
- `name()` = "USDC", `version()` = "2", `decimals()` = 6;
- `DOMAIN_SEPARATOR()` = ON_CHAIN_DOMAIN_SEPARATOR below;
- `RECEIVE_WITH_AUTHORIZATION_TYPEHASH()` = ON_CHAIN_TYPE_HASH below.
The generator recomputes the separator from {name, version, chainId, verifyingContract} and refuses
to write unless it equals the recorded on-chain value. So for this token the domain check takes the
fallback path: recompute from name() and version() and the configured chainId and address, and
require equality with DOMAIN_SEPARATOR(). The EIP-5267 path is covered with synthetic readings.

The authorization is in its JSON form (04 §2.4.1 `auth`, 07 §7): addresses and `nonce` 0x +
lowercase hex of their size, `value`, `validAfter` and `validBefore` canonical decimal strings up to
2^256 - 1, exactly the six fields, and validBefore > validAfter (an authorization that can never be
valid is refused, never signed). Every non-canonical form is rejected, never normalised.

The signing key is a test key derived from a labelled test seed (vectorlib.det); it exists only in
this suite's vectors.json, the one place the secret scan allowlists. The vault and the other
addresses are synthetic too.

Usage: python3 -I tools/vectors/generate_eip3009.py --check [FILE] | --write
"""

import copy
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import generate_eip712 as e  # noqa: E402
import vectorlib as v  # noqa: E402

SUITE = "eip3009"
VERSION = 1

DOMAIN_FIELDS = [
    {"name": "name", "type": "string"},
    {"name": "version", "type": "string"},
    {"name": "chainId", "type": "uint256"},
    {"name": "verifyingContract", "type": "address"},
]
AUTH_FIELDS = [
    {"name": "from", "type": "address"},
    {"name": "to", "type": "address"},
    {"name": "value", "type": "uint256"},
    {"name": "validAfter", "type": "uint256"},
    {"name": "validBefore", "type": "uint256"},
    {"name": "nonce", "type": "bytes32"},
]
TYPES = {"EIP712Domain": DOMAIN_FIELDS, "ReceiveWithAuthorization": AUTH_FIELDS}
TRANSFER_TYPES = {"EIP712Domain": DOMAIN_FIELDS, "TransferWithAuthorization": AUTH_FIELDS}

RECEIVE_TYPE_STRING = "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
TRANSFER_TYPE_STRING = "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"

# Read on chain (see the module docstring): Base Sepolia, block 49070689.
BASE_SEPOLIA = 84532
USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
USDC_NAME = "USDC"
USDC_VERSION = "2"
ON_CHAIN_DOMAIN_SEPARATOR = "71f17a3b2ff373b803d70a5a07c046c1a2bc8e89c09ef722fcb047abe94c9818"
ON_CHAIN_TYPE_HASH = "d099cc98ef71107a616c4f0f941f04c322d8e254fe26b3c6668db87aae413de8"
ON_CHAIN_SOURCE = "eth_call on Base Sepolia (84532) at block 49070689 to USDC 0x036CbD53842c5426634e7929541eC2318f3dCF7e"

UINT256_MAX = 2**256 - 1
ZERO32 = "0x" + "00" * 32
AUTH_SOURCE = "EIP-3009 ReceiveWithAuthorization; 03 §4.4, 05 §2.5 (payee = fee vault); 04 §2.4.1 auth JSON form"
DOMAIN_SOURCE = "EIP-712 domain separator of a token domain {name, version, chainId, verifyingContract} read from chain"
CHECK_SOURCE = "M3-4b: the token domain is read from chain (EIP-5267 eip712Domain(), else name(), version() and DOMAIN_SEPARATOR() recomputed and compared), never hard-coded"


def addr(label):
    return "0x" + v.det(f"eip3009/{label}", 20).hex()


def b32(label):
    return "0x" + v.det(f"eip3009/{label}", 32).hex()


USDC = USDC_BASE_SEPOLIA.lower()
USDC_DOMAIN = {"name": USDC_NAME, "version": USDC_VERSION, "chainId": BASE_SEPOLIA, "verifyingContract": USDC}
VAULT = addr("fee-vault")
AGENT_SECRET = v.det("eip3009/agent/evm", 32)
AGENT = v.evm_address(AGENT_SECRET)


# --- strict forms --------------------------------------------------------------------------------


def parse_domain(domain):
    """A token domain: exactly the four fields; name and version strings; chainId a JSON integer in
    [1, 2^53 - 1]; verifyingContract 0x + 40 hex, lowercase or a valid EIP-55 checksum."""
    if not isinstance(domain, dict) or set(domain) != {f["name"] for f in DOMAIN_FIELDS}:
        raise ValueError("not exactly the domain fields")
    if not isinstance(domain["name"], str) or not isinstance(domain["version"], str):
        raise ValueError("name and version must be strings")
    chain_id = domain["chainId"]
    if isinstance(chain_id, bool) or not isinstance(chain_id, int) or not 1 <= chain_id <= 2**53 - 1:
        raise ValueError("chainId out of range")
    contract = domain["verifyingContract"]
    if not isinstance(contract, str) or not re.fullmatch(r"0x[0-9a-fA-F]{40}", contract):
        raise ValueError("verifyingContract is not 0x + 40 hex")
    if not re.fullmatch(r"0x[0-9a-f]{40}", contract) and v.eip55(contract.lower()) != contract:
        raise ValueError("verifyingContract is neither lowercase nor valid EIP-55")
    return {**domain, "verifyingContract": contract.lower()}


def parse_auth(auth):
    if not isinstance(auth, dict) or set(auth) != {f["name"] for f in AUTH_FIELDS}:
        raise ValueError("not exactly the struct's fields")
    for field in AUTH_FIELDS:
        name, kind, value = field["name"], field["type"], auth[field["name"]]
        if kind == "address":
            if not isinstance(value, str) or not re.fullmatch(r"0x[0-9a-f]{40}", value):
                raise ValueError(f"{name} is not canonical")
        elif kind == "bytes32":
            if not isinstance(value, str) or not re.fullmatch(r"0x[0-9a-f]{64}", value):
                raise ValueError(f"{name} is not canonical")
        else:
            if not isinstance(value, str) or not re.fullmatch(r"0|[1-9][0-9]*", value) or int(value) > UINT256_MAX:
                raise ValueError(f"{name} is not a canonical uint256 decimal string")
    if int(auth["validBefore"]) <= int(auth["validAfter"]):
        raise ValueError("validBefore must be after validAfter")
    return auth


def message(auth):
    return {**auth, **{k: int(auth[k]) for k in ("value", "validAfter", "validBefore")}}


def domain_separator(domain):
    return e.hash_struct(TYPES, "EIP712Domain", parse_domain(domain)).hex()


def hashes(domain, auth):
    parse_auth(auth)
    d = parse_domain(domain)
    return {
        "typeHash": e.type_hash(TYPES, "ReceiveWithAuthorization").hex(),
        "domainSeparator": e.hash_struct(TYPES, "EIP712Domain", d).hex(),
        "structHash": e.hash_struct(TYPES, "ReceiveWithAuthorization", message(auth)).hex(),
        "digest": e.digest(TYPES, "ReceiveWithAuthorization", d, message(auth)).hex(),
    }


def sign(domain, auth, secret):
    """0x + 130 lowercase hex, r || s || v with v in {27, 28} and low s (04 §2.4.1)."""
    parse_auth(auth)
    digest = e.digest(TYPES, "ReceiveWithAuthorization", parse_domain(domain), message(auth))
    r, s, y = e.ecdsa_sign(secret, digest)
    if int(s, 16) > v_n() // 2:
        v.fail("coincurve returned a high s")
    recovered = e.recover(digest, r, s, y)
    if recovered != auth["from"]:
        v.fail("the signature does not recover the authorization's from")
    return "0x" + r + s + format(27 + y, "02x")


def v_n():
    return 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141


def parse_uint256_text(value):
    if not isinstance(value, str) or not re.fullmatch(r"0|[1-9][0-9]*", value) or int(value) > UINT256_MAX:
        raise ValueError("not a canonical uint256 decimal string")
    return int(value)


def bytes32_text(value):
    if not isinstance(value, str) or not re.fullmatch(r"0x[0-9a-f]{64}", value):
        raise ValueError("not 0x + 64 lowercase hex")
    return value


def verify_token_domain(expected, reading):
    """The reference rule for the code under test's verifyTokenDomain. `expected` is the configured
    {chainId, verifyingContract}. `reading` is what the caller read from the token:
    - {source: "eip5267", fields, name, version, chainId, verifyingContract, salt, extensions,
       domainSeparator?}: eip712Domain() as returned (fields "0x0f" exactly: name, version,
       chainId and verifyingContract, no salt, no extensions; chainId a decimal string), and
       optionally DOMAIN_SEPARATOR(), which then must match too;
    - {source: "domainSeparator", name, version, domainSeparator}: the fallback for a token
       without EIP-5267.
    Accepts only when the chain ID and the address equal the configured ones and, where the token
    reports a separator, the recomputed one equals it. Returns the domain with a lowercase address."""
    if not isinstance(expected, dict) or set(expected) != {"chainId", "verifyingContract"}:
        raise ValueError("expected is not exactly chainId and verifyingContract")
    configured = parse_domain({"name": "", "version": "", **expected})
    if not isinstance(reading, dict) or "source" not in reading:
        raise ValueError("reading has no source")
    source = reading["source"]
    if source == "eip5267":
        required = {"source", "fields", "name", "version", "chainId", "verifyingContract", "salt", "extensions"}
        if not required <= set(reading) or not set(reading) <= required | {"domainSeparator"}:
            raise ValueError("not exactly the eip712Domain() fields")
        if reading["fields"] != "0x0f":
            raise ValueError("fields must be 0x0f")
        if bytes32_text(reading["salt"]) != ZERO32:
            raise ValueError("salt must be zero")
        if not isinstance(reading["extensions"], list) or reading["extensions"]:
            raise ValueError("extensions must be empty")
        if parse_uint256_text(reading["chainId"]) != configured["chainId"]:
            raise ValueError("another chain")
        domain = parse_domain({"name": reading["name"], "version": reading["version"], "chainId": configured["chainId"], "verifyingContract": reading["verifyingContract"]})
        if domain["verifyingContract"] != configured["verifyingContract"]:
            raise ValueError("another contract")
        separator = domain_separator(domain)
        if "domainSeparator" in reading and bytes32_text(reading["domainSeparator"])[2:] != separator:
            raise ValueError("DOMAIN_SEPARATOR() differs")
    elif source == "domainSeparator":
        if set(reading) != {"source", "name", "version", "domainSeparator"}:
            raise ValueError("not exactly name, version and domainSeparator")
        domain = parse_domain({"name": reading["name"], "version": reading["version"], **{k: configured[k] for k in ("chainId", "verifyingContract")}})
        separator = domain_separator(domain)
        if bytes32_text(reading["domainSeparator"])[2:] != separator:
            raise ValueError("DOMAIN_SEPARATOR() differs")
    else:
        raise ValueError("unknown source")
    return domain, separator


# --- self-checks ---------------------------------------------------------------------------------


def self_check():
    mail, p = e.MAIL, e.MAIL_PUBLISHED
    if e.digest(mail["types"], "Mail", mail["domain"], mail["message"]).hex() != p["digest"]:
        v.fail("the EIP-712 digest differs from Example.js")
    if e.encode_type(TYPES, "ReceiveWithAuthorization") != RECEIVE_TYPE_STRING:
        v.fail("encodeType(ReceiveWithAuthorization) is not the EIP-3009 struct")
    receive = e.type_hash(TYPES, "ReceiveWithAuthorization").hex()
    if receive != v.keccak256(RECEIVE_TYPE_STRING.encode()).hex() or receive != ON_CHAIN_TYPE_HASH:
        v.fail("the ReceiveWithAuthorization type hash differs from FiatToken's")
    if e.encode_type(TRANSFER_TYPES, "TransferWithAuthorization") != TRANSFER_TYPE_STRING:
        v.fail("encodeType(TransferWithAuthorization) is not the EIP-3009 struct")
    if e.type_hash(TRANSFER_TYPES, "TransferWithAuthorization").hex() == receive:
        v.fail("the Transfer and Receive type hashes are equal")
    if v.eip55(USDC) != USDC_BASE_SEPOLIA:
        v.fail("the recorded USDC address is not its EIP-55 form")
    if domain_separator(USDC_DOMAIN) != ON_CHAIN_DOMAIN_SEPARATOR:
        v.fail("the recomputed USDC domain separator differs from DOMAIN_SEPARATOR() on chain")


# --- cases ---------------------------------------------------------------------------------------


def variant(original, **changes):
    out = copy.deepcopy(original)
    for key, change in changes.items():
        if change is None:
            del out[key]
        else:
            out[key] = change
    return out


def build():
    self_check()
    cases = [
        v.case(
            "type-hash-constant",
            f"EIP-3009: keccak256(\"{RECEIVE_TYPE_STRING}\"), equal to RECEIVE_WITH_AUTHORIZATION_TYPEHASH() ({ON_CHAIN_SOURCE}); never the TransferWithAuthorization type hash",
            {"op": "typeHashConstant"},
            {"typeHash": ON_CHAIN_TYPE_HASH},
        )
    ]

    # Domain separators.
    for case_id, why, domain in [
        ("domain-usdc-base-sepolia", f"Circle USDC on Base Sepolia: name \"{USDC_NAME}\", version \"{USDC_VERSION}\"; equals DOMAIN_SEPARATOR() ({ON_CHAIN_SOURCE})", USDC_DOMAIN),
        ("domain-usdc-base-sepolia-eip55", "the same domain with the address in its EIP-55 form, as a chain read returns it", variant(USDC_DOMAIN, verifyingContract=USDC_BASE_SEPOLIA)),
        ("domain-usdc-other-name", "the name \"USD Coin\" (Circle's mainnet name): another separator", variant(USDC_DOMAIN, name="USD Coin")),
        ("domain-usdc-base-mainnet-chain", "chainId 8453 (Base mainnet) with the same address: another separator", variant(USDC_DOMAIN, chainId=8453)),
    ]:
        cases.append(v.case(case_id, f"{DOMAIN_SOURCE}; {why}", {"op": "domainSeparator", "domain": domain}, {"domainSeparator": domain_separator(domain)}))
    if cases[1]["expected"]["domainSeparator"] != ON_CHAIN_DOMAIN_SEPARATOR:
        v.fail("domain-usdc-base-sepolia is not the on-chain separator")

    bad_checksum = "0x" + "".join(c.lower() if c.isupper() else c.upper() for c in USDC_BASE_SEPOLIA[2:])
    for case_id, why, domain in [
        ("uppercase-address", "verifyingContract in upper-case hex (neither lowercase nor EIP-55)", variant(USDC_DOMAIN, verifyingContract="0x" + USDC[2:].upper())),
        ("bad-checksum", "verifyingContract with a wrong EIP-55 checksum", variant(USDC_DOMAIN, verifyingContract=bad_checksum)),
        ("chain-id-zero", "chainId 0", variant(USDC_DOMAIN, chainId=0)),
        ("chain-id-string", "chainId as a string", variant(USDC_DOMAIN, chainId="84532")),
        ("name-number", "name as a number", variant(USDC_DOMAIN, name=1)),
        ("missing-version", "version missing", variant(USDC_DOMAIN, version=None)),
        ("extra-salt", "a fifth field salt", variant(USDC_DOMAIN, salt=ZERO32)),
    ]:
        try:
            parse_domain(domain)
            v.fail(f"domain {case_id} parses")
        except ValueError:
            pass
        cases.append(v.case(f"domain-reject-{case_id}", f"{DOMAIN_SOURCE}: {why}; rejected", {"op": "domainSeparator", "domain": domain}, {"outcome": "reject"}))

    # Domain check against the chain.
    configured = {"chainId": BASE_SEPOLIA, "verifyingContract": USDC}
    configured_eip55 = {"chainId": BASE_SEPOLIA, "verifyingContract": USDC_BASE_SEPOLIA}
    fallback = {"source": "domainSeparator", "name": USDC_NAME, "version": USDC_VERSION, "domainSeparator": "0x" + ON_CHAIN_DOMAIN_SEPARATOR}
    eip5267 = {
        "source": "eip5267",
        "fields": "0x0f",
        "name": USDC_NAME,
        "version": USDC_VERSION,
        "chainId": str(BASE_SEPOLIA),
        "verifyingContract": USDC_BASE_SEPOLIA,
        "salt": ZERO32,
        "extensions": [],
    }
    accepts = [
        ("fallback-usdc-base-sepolia", f"the real reading of USDC on Base Sepolia, which has no eip712Domain(): name(), version() and DOMAIN_SEPARATOR() ({ON_CHAIN_SOURCE})", configured, fallback),
        ("fallback-configured-eip55", "the same with the configured address in EIP-55 form", configured_eip55, fallback),
        ("eip5267", "a synthetic EIP-5267 reading of the same domain (fields 0x0f, zero salt, no extensions)", configured, eip5267),
        ("eip5267-with-separator", "a synthetic EIP-5267 reading plus a matching DOMAIN_SEPARATOR()", configured, variant(eip5267, domainSeparator="0x" + ON_CHAIN_DOMAIN_SEPARATOR)),
    ]
    for case_id, why, exp, reading in accepts:
        domain, separator = verify_token_domain(exp, reading)
        cases.append(
            v.case(
                f"verify-accept-{case_id}",
                f"{CHECK_SOURCE}; {why}",
                {"op": "verifyTokenDomain", "expected": exp, "reading": reading},
                {"outcome": "accept", "name": domain["name"], "version": domain["version"], "domainSeparator": separator},
            )
        )

    other_separator = domain_separator(variant(USDC_DOMAIN, name="USD Coin"))
    rejects = [
        ("fallback-name-mismatch", "name() reads \"USD Coin\" but DOMAIN_SEPARATOR() is the USDC one", configured, variant(fallback, name="USD Coin")),
        ("fallback-version-mismatch", "version() reads \"1\"", configured, variant(fallback, version="1")),
        ("fallback-other-chain", "configured chainId 8453 (Base mainnet) against the Base Sepolia separator", {"chainId": 8453, "verifyingContract": USDC}, fallback),
        ("fallback-other-contract", "another configured token address against the USDC separator", {"chainId": BASE_SEPOLIA, "verifyingContract": addr("other-token")}, fallback),
        ("fallback-separator-of-other-domain", "DOMAIN_SEPARATOR() of another domain", configured, variant(fallback, domainSeparator="0x" + other_separator)),
        ("fallback-no-separator", "name() and version() without DOMAIN_SEPARATOR(): nothing to compare, so not read from chain", configured, variant(fallback, domainSeparator=None)),
        ("fallback-separator-uppercase", "DOMAIN_SEPARATOR() in upper-case hex", configured, variant(fallback, domainSeparator="0x" + ON_CHAIN_DOMAIN_SEPARATOR.upper())),
        ("fallback-extra-field", "a chainId the caller did not configure, in a fallback reading", configured, variant(fallback, chainId=str(BASE_SEPOLIA))),
        ("eip5267-other-chain", "eip712Domain() reports chainId 8453", configured, variant(eip5267, chainId="8453")),
        ("eip5267-other-contract", "eip712Domain() reports another verifyingContract", configured, variant(eip5267, verifyingContract=addr("other-token"))),
        ("eip5267-fields-salt", "fields 0x1f (a salt is part of the domain)", configured, variant(eip5267, fields="0x1f")),
        ("eip5267-fields-no-chain", "fields 0x0b (no chainId in the domain)", configured, variant(eip5267, fields="0x0b")),
        ("eip5267-nonzero-salt", "a non-zero salt", configured, variant(eip5267, salt=b32("salt"))),
        ("eip5267-extensions", "a non-empty extensions list", configured, variant(eip5267, extensions=["1"])),
        ("eip5267-chain-id-number", "chainId as a JSON number (the reading form is a decimal string)", configured, variant(eip5267, chainId=BASE_SEPOLIA)),
        ("eip5267-separator-mismatch", "a DOMAIN_SEPARATOR() that differs from the eip712Domain() fields", configured, variant(eip5267, domainSeparator="0x" + other_separator)),
        ("unknown-source", "an unknown source", configured, variant(fallback, source="config")),
        ("expected-extra-name", "a configured name (the name is never configured, it is read)", {**configured, "name": USDC_NAME}, fallback),
    ]
    for case_id, why, exp, reading in rejects:
        try:
            verify_token_domain(exp, reading)
            v.fail(f"verify {case_id} accepts")
        except ValueError:
            pass
        cases.append(v.case(f"verify-reject-{case_id}", f"{CHECK_SOURCE}: {why}; refused", {"op": "verifyTokenDomain", "expected": exp, "reading": reading}, {"outcome": "reject"}))

    # The authorization: hashing.
    auth = {
        "from": AGENT,
        "to": VAULT,
        "value": "5000000",
        "validAfter": "0",
        "validBefore": "1760003600",
        "nonce": b32("auth/nonce"),
    }
    limits = {
        "from": "0x" + "ff" * 20,
        "to": "0x" + "ff" * 20,
        "value": str(UINT256_MAX),
        "validAfter": str(UINT256_MAX - 1),
        "validBefore": str(UINT256_MAX),
        "nonce": "0x" + "ff" * 32,
    }
    for case_id, why, domain, a in [
        ("usdc-base-sepolia", "5 USDC (6 decimals) from the agent to the fee vault under the on-chain USDC domain", USDC_DOMAIN, auth),
        ("usdc-base-sepolia-eip55-domain", "the same under the domain with an EIP-55 address: the same hashes", variant(USDC_DOMAIN, verifyingContract=USDC_BASE_SEPOLIA), auth),
        ("other-nonce", "another 32-byte nonce: another struct hash and digest", USDC_DOMAIN, variant(auth, nonce=b32("auth/nonce-2"))),
        ("one-unit-window", "value 1, validAfter 1760000000, validBefore 1760000001 (the shortest window)", USDC_DOMAIN, variant(auth, value="1", validAfter="1760000000", validBefore="1760000001")),
        ("limits", "every field at its maximum", USDC_DOMAIN, limits),
    ]:
        cases.append(v.case(f"auth-{case_id}", f"{AUTH_SOURCE}; {why}", {"op": "receiveWithAuthorization", "domain": domain, "authorization": a}, hashes(domain, a)))
    if cases[-5]["expected"]["domainSeparator"] != ON_CHAIN_DOMAIN_SEPARATOR:
        v.fail("auth-usdc-base-sepolia is not under the on-chain separator")

    auth_rejects = [
        ("value-number", "value as a JSON number", variant(auth, value=5000000)),
        ("value-leading-zero", "value \"05000000\"", variant(auth, value="05000000")),
        ("value-2-pow-256", "value = 2^256 (above uint256)", variant(auth, value=str(2**256))),
        ("value-negative", "value \"-1\"", variant(auth, value="-1")),
        ("value-hex", "value as 0x hex", variant(auth, value=hex(5000000))),
        ("valid-before-equal", "validBefore equal to validAfter", variant(auth, validAfter="1760003600")),
        ("valid-before-earlier", "validBefore before validAfter", variant(auth, validAfter="1760003601")),
        ("from-uppercase", "from in upper-case hex", variant(auth, **{"from": "0x" + AGENT[2:].upper()})),
        ("to-mixed-case", "to in EIP-55 mixed case", variant(auth, to=v.eip55(VAULT))),
        ("to-no-prefix", "to without 0x", variant(auth, to=VAULT[2:])),
        ("nonce-uppercase", "nonce in upper-case hex", variant(auth, nonce="0x" + auth["nonce"][2:].upper())),
        ("nonce-decimal", "nonce as a decimal string", variant(auth, nonce=str(int(auth["nonce"], 16)))),
        ("nonce-31-bytes", "nonce of 31 bytes", variant(auth, nonce=auth["nonce"][:-2])),
        ("missing-nonce", "nonce missing", variant(auth, nonce=None)),
        ("extra-key", "a seventh field", variant(auth, deadline="1760003600")),
    ]
    for case_id, why, bad in auth_rejects:
        try:
            parse_auth(bad)
            v.fail(f"auth {case_id} parses")
        except ValueError:
            pass
        cases.append(v.case(f"auth-reject-{case_id}", f"{AUTH_SOURCE}: {why}; rejected, never normalised", {"op": "receiveWithAuthorization", "domain": USDC_DOMAIN, "authorization": bad}, {"outcome": "reject"}))

    # The authorization: signing with the agent EVM key (a test key).
    for case_id, why, a in [
        ("usdc-base-sepolia", "the agent's signature over auth-usdc-base-sepolia", auth),
        ("other-nonce", "the same with another nonce", variant(auth, nonce=b32("auth/nonce-2"))),
    ]:
        cases.append(
            v.case(
                f"sign-{case_id}",
                f"{AUTH_SOURCE}; deterministic ECDSA (RFC 6979, low s) by a test agent EVM key; {why}; recovers `from`",
                {"op": "signReceiveWithAuthorization", "domain": USDC_DOMAIN, "authorization": a, "secretKey": AGENT_SECRET.hex()},
                {"signature": sign(USDC_DOMAIN, a, AGENT_SECRET)},
            )
        )
    return cases


HASHES = {"typeHash": v.hexn(32), "domainSeparator": v.hexn(32), "structHash": v.hexn(32), "digest": v.hexn(32)}
SIGNATURE_0X = {"type": "string", "pattern": "^0x[0-9a-f]{130}$"}
ACCEPT_DOMAIN = {**v.ACCEPT, "name": v.STRING, "version": v.STRING, "domainSeparator": v.hexn(32)}
SCHEMA = v.case_schema(
    SUITE,
    "EIP-3009 ReceiveWithAuthorization (03 §4.4, 05 §2.5; 04 §2.4.1). `typeHashConstant`: the "
    "exported type hash. `domainSeparator`: the EIP-712 separator of a token domain, or a "
    "rejection. `verifyTokenDomain`: the configured {chainId, verifyingContract} against what the "
    "token reports (eip712Domain(), or name(), version() and DOMAIN_SEPARATOR()); accept with the "
    "domain's name, version and separator, or reject. `receiveWithAuthorization`: typeHash, domain "
    "separator, struct hash and digest (32-byte hex without 0x), or a rejection of a non-canonical "
    "authorization. `signReceiveWithAuthorization`: the 0x + 130 hex signature by a test key.",
    {
        "typeHashConstant": ({}, [{"typeHash": v.hexn(32)}]),
        "domainSeparator": ({"domain": v.OBJECT}, [{"domainSeparator": v.hexn(32)}, v.REJECT]),
        "verifyTokenDomain": ({"expected": v.OBJECT, "reading": v.OBJECT}, [ACCEPT_DOMAIN, v.REJECT]),
        "receiveWithAuthorization": ({"domain": v.OBJECT, "authorization": v.OBJECT}, [HASHES, v.REJECT]),
        "signReceiveWithAuthorization": ({"domain": v.OBJECT, "authorization": v.OBJECT, "secretKey": v.hexn(32)}, [{"signature": SIGNATURE_0X}]),
    },
)

if __name__ == "__main__":
    v.main(
        suite=SUITE,
        version=VERSION,
        script="tools/vectors/generate_eip3009.py",
        libraries=["coincurve", "pycryptodome"],
        build=build,
        schema=SCHEMA,
        doc=__doc__,
    )
