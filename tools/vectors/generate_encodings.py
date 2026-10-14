#!/usr/bin/env python3
"""Independent generator for the `encodings` suite: canonical binary encodings (M1-1h).

04 §2.4.1: every binary value has exactly one spelling, chosen by schema and path (never by field
name alone: `nonce`, `sig`/`signature`, `id`, `agentId` and `signer` are overloaded). The table's
rows, each with the paths it lists:
  0x + 40 lowercase hex (address); 0x + 64 lowercase hex (bytes32); 0x + hex (ECDSA signature);
  decimal string (uint256); 64 lowercase hex (Nostr key); 128 lowercase hex (BIP-340);
  64 lowercase hex (digest under a Nostr key only); base64url without padding; the prefixed
  `approvalId` (apr_ + base64url of 16 bytes, 26 characters); tool results (the row they mirror).
Non-canonical forms are rejected, never normalised: upper or mixed case (EIP-55 included), a
missing or extra 0x, 0X, a wrong length, whitespace; padded base64url, + or /, non-zero trailing
bits; a decimal not matching ^(0|[1-9][0-9]*)$ or above the type's maximum. ECDSA (EOA, 65 bytes):
r and s in [1, n - 1], s <= n/2, v in {27, 28}. JSON integer tokens must match 0|[1-9][0-9]* and
stay within [0, 2^53 - 1], checked on the token text. Equality compares decoded bytes, so a card's
`ownerNostr` (0x + 64 hex) and an OwnerAction `owner` (64 hex) for the same key are equal.

Cases: `decode` gives the canonical form of every path in the table, and each non-canonical form
applied to a path of each row; a wrong length on every fixed-length base64url path (the lengths
come from each field's own spec line: 04 §2.5.1, §3.1, §3.3, §3.4, §3.4.1, §3.4.2, §3.6, §3.6.1;
07 §5.4 gives no length for the drop request nonce); `parseInteger` gives JSON number tokens as
text; `equalBytes` gives the cross-class comparisons, with equality reported apart from a parse
failure. Path names are written `<schema>.<path>` as the table names them. The
reference decoder is this generator's own reading of the table (Python `re` and `base64`). Values
are synthetic (public keys, hashes, made-up signatures); no secret.

Usage: python3 -I tools/vectors/generate_encodings.py --check [FILE] | --write
"""

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import vectorlib as v  # noqa: E402

SUITE = "encodings"
VERSION = 1
SPEC = "04 §2.4.1"
N = v.SECP256K1_N

ROWS = {
    "address": [
        "OwnerAction.agent", "contact.check.params.contact", "tool.contact.id", "tool.agent.id", "approval-request.agent", "terms.parties[]", "terms.deliverables[].by",
        "terms.price.payer", "CommitmentScope.agentId", "CommitmentScope.counterparty.agentId",
        "AgentCard.agentEvm", "AgentCard.ownerEvm", "ProofPack.notary", "ProofPack.signer.evm",
        "ProofPack.recipient.evm", "ProofPack.receipts[].signer", "Record.signer", "Receipt.signer",
        "Record.feeToken", "EIP3009.auth.from", "EIP3009.auth.to", "ProofStatus.signer",
    ],
    "bytes32": [
        "proof.recordId", "ProofPack.recordId", "handshake-ack.handshakeHash", "proof.salt", "ProofPack.recipient.salt",
        "CommitmentScope.answers.envelopeHash", "ProofPack.envelopeHash", "Record.envelopeHash",
        "Record.recipientCommitment", "Record.parentRecordId", "Record.appId", "Receipt.recordId",
        "Receipt.salt", "recordStructHash", "txHash", "AgentCard.agentNostr", "AgentCard.agentEnc",
        "AgentCard.ownerNostr", "AgentCard.ownerEnc", "AgentCard.nameHash", "AgentCard.relaysHash",
        "DomainClaim.ownerNostr", "EIP3009.auth.nonce", "EIP3009.auth.r", "EIP3009.auth.s",
        "ProofStatus.recordId", "ProofStatus.txHash", "verify_proof_pack.recordId", "verify_proof_pack.envelopeHash",
    ],
    "ecdsa": [
        "invite.cardSig", "handshake.cardSig", "handshake-ack.cardSig", "card-update.cardSig",
        "invite.cardAgentSig", "handshake.cardAgentSig", "ProofPack.signature",
        "submitter.records[].signature", "submitter.receipts[].signature",
    ],
    "uint256": ["Record.maxFee", "Record.nonce", "EIP3009.auth.value", "EIP3009.auth.validAfter", "EIP3009.auth.validBefore"],
    "nostr-key": ["envelope.from", "OwnerAction.owner", "CommitmentScope.counterparty.ownerKey", "nostr.eventId"],
    "bip340-sig": ["envelope.sig", "SignedOwnerAction.sig"],
    "digest": [
        "approval-request.actionDigest", "approval.decide.params.actionDigest", "terms-body.termsHash",
        "terms.previousTermsHash", "CommitmentScope.termsHash", "payload.files[].plaintextSha256",
        "terms.deliverables[].plaintextSha256", "payload.files[].ciphertextSha256",
        "drop-commit.ciphertextSha256", "ProofPack.ownerApproval.policyHash", "handshake.inviterCardHash",
        "contact.check.params.pairingDigest", "tool.termsHash",
    ],
    "base64url": [
        "envelope.id", "envelope.thread", "envelope.recipients[].kid", "envelope.recipients[].enc",
        "envelope.recipients[].wk", "envelope.aead.iv", "envelope.aead.ct", "payload.replyTo",
        "payload.files[].inline", "payload.files[].fileKey", "proof.envelopeId",
        "CommitmentScope.answers.envelopeId", "CommitmentScope.thread", "CommitmentScope.termsId",
        "terms.termsId", "invite.inviteId", "invite.secret", "invite.codeCommit", "handshake.inviteId",
        "handshake.proof", "handshake.codeNonce", "handshake.codeCommit", "handshake-ack.inviteId",
        "handshake-ack.handshakeId", "handshake-ack.codeReveal", "OwnerAction.nonce", "drop-request.nonce",
        "ProofPack.disclosure.contentKey", "tool.envelopeId",
    ],
    "approval-id": ["approvalId"],
}
PATH_CLASS = {path: row for row, paths in ROWS.items() for path in paths}
HEX_CLASSES = {"address": ("0x", 20), "bytes32": ("0x", 32), "nostr-key": ("", 32), "bip340-sig": ("", 64), "digest": ("", 32)}
EOA_ONLY = {"invite.cardSig", "handshake.cardSig", "handshake-ack.cardSig", "card-update.cardSig", "invite.cardAgentSig", "handshake.cardAgentSig"}

# Byte lengths of the base64url paths (IR-M1-1h-2 F-A), from the spec of each field: an int is
# exact, ("min", n) a lower bound, ("max", n) an upper bound, None no length in the spec.
B64U_LENGTH = {
    "envelope.id": 16, "envelope.thread": 16, "envelope.recipients[].kid": 16,  # 04 §3.1
    "envelope.recipients[].enc": 32,  # X25519 encapsulated key (04 §3.3, RFC 9180 Nenc)
    "envelope.recipients[].wk": 48,  # 32-byte CEK + 16-byte tag (04 §3.3)
    "envelope.aead.iv": 12, "envelope.aead.ct": ("min", 16),  # 04 §3.1
    "payload.replyTo": 16,  # an envelope id (04 §3.4)
    "payload.files[].inline": ("max", 12 * 1024),  # 04 §3.4: inline files <= 12 KB
    "payload.files[].fileKey": 32,  # base64url(32) (04 §3.4)
    "proof.envelopeId": 16, "CommitmentScope.answers.envelopeId": 16, "CommitmentScope.thread": 16,
    "CommitmentScope.termsId": 16, "terms.termsId": 16,  # 04 §3.4, §3.4.2
    "invite.inviteId": 16, "invite.secret": 32, "invite.codeCommit": 32,  # 04 §3.6
    "handshake.inviteId": 16, "handshake.proof": 32, "handshake.codeNonce": 32, "handshake.codeCommit": 32,  # 04 §3.6, §3.6.1
    "handshake-ack.inviteId": 16, "handshake-ack.handshakeId": 16, "handshake-ack.codeReveal": 32,  # 04 §3.4.1, §3.6.1
    "OwnerAction.nonce": 16,  # 04 §2.5.1
    "drop-request.nonce": None,  # 07 §5.4 gives no length (spec gap, see the PR)
    "ProofPack.disclosure.contentKey": 32,  # the CEK (04 §3.3)
    "tool.envelopeId": 16,
}


def decode(path, value):
    kind = PATH_CLASS[path]
    if not isinstance(value, str):
        raise ValueError("not a string")
    if kind == "uint256":
        if not re.fullmatch(r"0|[1-9][0-9]*", value) or int(value) > 2**256 - 1:
            raise ValueError("not a canonical uint256")
        return int(value).to_bytes(32, "big")
    if kind == "base64url":
        raw = v.unb64u(value)
        rule = B64U_LENGTH[path]
        if (isinstance(rule, int) and len(raw) != rule) or (
            isinstance(rule, tuple) and ((rule[0] == "min" and len(raw) < rule[1]) or (rule[0] == "max" and len(raw) > rule[1]))
        ):
            raise ValueError("wrong length")
        return raw
    if kind == "approval-id":
        if len(value) != 26 or not value.startswith("apr_"):
            raise ValueError("not an approvalId")
        raw = v.unb64u(value[4:])
        if len(raw) != 16:
            raise ValueError("not 16 bytes")
        return raw
    if kind == "ecdsa":
        if not re.fullmatch(r"0x([0-9a-f]{2})+", value):
            raise ValueError("not canonical hex")
        raw = bytes.fromhex(value[2:])
        if len(raw) == 65 or path in EOA_ONLY:
            r, s, v_byte = int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:64], "big"), raw[64:]
            if len(raw) != 65 or not 1 <= r < N or not 1 <= s <= N // 2 or v_byte not in (b"\x1b", b"\x1c"):
                raise ValueError("not a canonical ECDSA signature")
        return raw
    prefix, size = HEX_CLASSES[kind]
    if not value.startswith(prefix) or not re.fullmatch(r"[0-9a-f]{%d}" % (2 * size), value[len(prefix) :]):
        raise ValueError("not canonical hex")
    return bytes.fromhex(value[len(prefix) :])


def parse_integer(token):
    if not re.fullmatch(r"0|[1-9][0-9]*", token) or int(token) > 2**53 - 1:
        raise ValueError("not a canonical JSON integer")
    return int(token)


def build():
    cases = []
    address = v.evm_address(v.det("encodings/agent/evm", 32))
    checksummed = v.eip55(address)
    if checksummed == address or checksummed == "0x" + address[2:].upper():
        v.fail("pick an address whose EIP-55 form is mixed case")
    b32 = v.sha256(b"encodings/bytes32")
    key = v.xonly_public_key(v.det("encodings/owner/nostr", 32))
    bip340 = v.sha256(b"encodings/R") + v.sha256(b"encodings/s")
    digest = v.sha256(b"encodings/digest")
    r = v.sha256(b"encodings/ecdsa-r")
    s_low = (int.from_bytes(v.sha256(b"encodings/ecdsa-s"), "big") % (N // 2)) + 1
    ecdsa = r + s_low.to_bytes(32, "big") + b"\x1b"
    raw16 = bytes.fromhex("fbff3e0f00ff10e0f8fe7d3c1b0a99ee")
    canonical = {
        "address": address,
        "bytes32": "0x" + b32.hex(),
        "ecdsa": "0x" + ecdsa.hex(),
        "uint256": "1500000",
        "nostr-key": key.hex(),
        "bip340-sig": bip340.hex(),
        "digest": digest.hex(),
        "base64url": v.b64u(raw16),
        "approval-id": "apr_" + v.b64u(raw16),
    }

    def slug(path):
        return re.sub(r"[^a-z0-9]+", "-", re.sub(r"([a-z0-9])([A-Z])", r"\1-\2", path).lower()).strip("-")

    def case(case_id, why, path, value, accept):
        try:
            result = decode(path, value)
        except ValueError:
            result = None
        if (result is not None) != accept:
            v.fail(f"{case_id}: unexpected decode result")
        cases.append(
            v.case(
                case_id,
                f"{SPEC}: {path} {why}" + ("" if accept else "; rejected, never normalised"),
                {"op": "decode", "path": path, "value": value},
                {"bytes": v.hx(result)} if accept else {"outcome": "reject"},
            )
        )

    def b64u_value(path):
        rule = B64U_LENGTH[path]
        size = rule if isinstance(rule, int) else (rule[1] if rule and rule[0] == "min" else 16)
        return v.b64u(v.det(f"encodings/{path}", size))

    # The canonical form of every path in the table (base64url paths at their own length).
    for row, paths in ROWS.items():
        for path in paths:
            value = b64u_value(path) if row == "base64url" else canonical[row]
            case(f"decode-{slug(path)}", "in its canonical form", path, value, True)

    # A wrong length on every fixed-length base64url path (IR-M1-1h-2 F-A).
    for path, rule in B64U_LENGTH.items():
        if isinstance(rule, int):
            case(f"reject-length-{slug(path)}-short", f"of {rule - 1} bytes (it is {rule})", path, v.b64u(v.det(f"encodings/{path}", rule - 1)), False)
            case(f"reject-length-{slug(path)}-long", f"of {rule + 1} bytes (it is {rule})", path, v.b64u(v.det(f"encodings/{path}", rule + 1)), False)
        elif rule is not None and rule[0] == "min":
            case(f"reject-length-{slug(path)}-short", f"of {rule[1] - 1} bytes (at least {rule[1]})", path, v.b64u(v.det(f"encodings/{path}", rule[1] - 1)), False)
        elif rule is not None and rule[0] == "max":
            case(f"decode-length-{slug(path)}-max", f"of {rule[1]} bytes (at most {rule[1]})", path, v.b64u(v.det(f"encodings/{path}", rule[1])), True)
            case(f"reject-length-{slug(path)}-long", f"of {rule[1] + 1} bytes (at most {rule[1]})", path, v.b64u(v.det(f"encodings/{path}", rule[1] + 1)), False)

    # Each non-canonical form, applied to a path of each row.
    a = canonical["address"]
    for case_id, value, why in [
        ("eip55", checksummed, "in EIP-55 mixed case"),
        ("uppercase", "0x" + a[2:].upper(), "in upper-case hex"),
        ("no-prefix", a[2:], "without 0x"),
        ("capital-prefix", "0X" + a[2:], "with 0X"),
        ("39-hex", a[:-1], "with 39 hex digits"),
        ("41-hex", a + "0", "with 41 hex digits"),
        ("whitespace", " " + a, "with leading whitespace"),
    ]:
        case(f"reject-address-{case_id}", why, "OwnerAction.agent", value, False)
    h = canonical["bytes32"]
    for case_id, path, value, why in [
        ("uppercase", "Record.envelopeHash", "0x" + h[2:].upper(), "in upper-case hex"),
        ("no-prefix", "AgentCard.ownerNostr", h[2:], "without 0x"),
        ("capital-prefix", "proof.recordId", "0X" + h[2:], "with 0X"),
        ("63-hex", "proof.recordId", h[:-1], "with 63 hex digits"),
        ("trailing-space", "txHash", h + " ", "with trailing whitespace"),
        ("base64url-record-id", "proof.recordId", v.b64u(b32), "as base64url"),
        ("base64url-salt", "proof.salt", v.b64u(b32), "as base64url"),
    ]:
        case(f"reject-bytes32-{case_id}", why, path, value, False)
    e = canonical["ecdsa"]
    s_high = (N - s_low).to_bytes(32, "big")
    for case_id, value, why in [
        ("high-s", "0x" + (r + s_high + b"\x1c").hex(), "with a high s (EIP-2)"),
        ("v-0", "0x" + (ecdsa[:64] + b"\x00").hex(), "with v = 0"),
        ("v-1", "0x" + (ecdsa[:64] + b"\x01").hex(), "with v = 1"),
        ("64-bytes", "0x" + ecdsa[:64].hex(), "of 64 bytes"),
        ("r-zero", "0x" + (bytes(32) + ecdsa[32:]).hex(), "with r = 0"),
        ("s-zero", "0x" + (r + bytes(32) + b"\x1b").hex(), "with s = 0"),
        ("r-n", "0x" + (N.to_bytes(32, "big") + ecdsa[32:]).hex(), "with r = n"),
        ("uppercase", "0x" + e[2:].upper(), "in upper-case hex"),
        ("no-prefix", e[2:], "without 0x"),
    ]:
        case(f"reject-ecdsa-{case_id}", why, "invite.cardSig", value, False)
    case("decode-proof-pack-signature-erc1271", "as an ERC-1271 signature of another length (0x + even hex)", "ProofPack.signature", "0x" + (v.sha256(b"encodings/erc1271") * 3).hex(), True)
    case("reject-proof-pack-signature-odd-hex", "with an odd number of hex digits", "ProofPack.signature", e[:-1], False)
    case("reject-proof-pack-signature-empty", "empty after 0x", "ProofPack.signature", "0x", False)
    case("reject-proof-pack-signature-high-s", "as a 65-byte signature with a high s", "ProofPack.signature", "0x" + (r + s_high + b"\x1c").hex(), False)
    for case_id, value in [("zero", "0"), ("max", str(2**256 - 1))]:
        case(f"decode-uint256-{case_id}", f"= {case_id}", "Record.maxFee", value, True)
    for case_id, value, why in [
        ("leading-zero", "01500", "with a leading zero"),
        ("plus", "+1500", "with a sign"),
        ("minus", "-1", "negative"),
        ("overflow", str(2**256), "of 2^256"),
        ("fraction", "1500.0", "with a fraction"),
        ("exponent", "1e3", "in exponent form"),
        ("hex", "0x5dc", "in hex"),
        ("whitespace", "1500 ", "with trailing whitespace"),
        ("empty", "", "empty"),
    ]:
        case(f"reject-uint256-{case_id}", why, "Record.nonce", value, False)
    k = canonical["nostr-key"]
    for case_id, path, value, why in [
        ("0x", "OwnerAction.owner", "0x" + k, "with 0x (Nostr-native)"),
        ("uppercase", "envelope.from", k.upper(), "in upper-case hex"),
        ("63-hex", "envelope.from", k[:-1], "with 63 hex digits"),
    ]:
        case(f"reject-nostr-key-{case_id}", why, path, value, False)
    b = canonical["bip340-sig"]
    case("reject-bip340-0x", "with 0x", "SignedOwnerAction.sig", "0x" + b, False)
    case("reject-bip340-uppercase", "in upper-case hex", "envelope.sig", b.upper(), False)
    case("reject-bip340-127-hex", "with 127 hex digits", "envelope.sig", b[:-1], False)
    d = canonical["digest"]
    case("reject-digest-0x", "with 0x (signed only under a Nostr key)", "approval.decide.params.actionDigest", "0x" + d, False)
    case("reject-digest-uppercase", "in upper-case hex", "terms-body.termsHash", d.upper(), False)
    case("reject-digest-base64url", "as base64url", "payload.files[].plaintextSha256", v.b64u(digest), False)
    t = canonical["base64url"]
    alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    for case_id, path, value, why in [
        ("padded", "envelope.id", t + "==", "with padding"),
        ("drop-nonce-padded", "drop-request.nonce", t + "==", "with padding"),
        ("standard-alphabet", "OwnerAction.nonce", t.replace("-", "+").replace("_", "/"), "with + and /"),
        ("trailing-bits", "invite.inviteId", t[:-1] + alphabet[alphabet.index(t[-1]) | 1], "with non-zero trailing bits"),
        ("whitespace", "envelope.recipients[].kid", t[:11] + " " + t[11:], "with whitespace"),
        ("impossible-length", "handshake.proof", t + "AAA", "with an impossible length (4n + 1 characters)"),
    ]:
        case(f"reject-base64url-{case_id}", why, path, value, False)
    ap = canonical["approval-id"]
    for case_id, value, why in [
        ("no-prefix", ap[4:], "without apr_"),
        ("uppercase-prefix", "APR_" + ap[4:], "with APR_"),
        ("padded", ap + "==", "with padding (28 characters)"),
        ("15-bytes", "apr_" + v.b64u(raw16[:15]), "of 15 bytes"),
        ("17-bytes", "apr_" + v.b64u(raw16 + b"\x00"), "of 17 bytes"),
        ("trailing-bits", ap[:-1] + alphabet[alphabet.index(ap[-1]) | 1], "with non-zero trailing bits"),
    ]:
        case(f"reject-approval-id-{case_id}", why, "approvalId", value, False)

    # JSON integer tokens (all non-uint256 integers), checked on the token text.
    for token, accept, why in [
        ("0", True, "zero"),
        ("1760000000", True, "a timestamp"),
        ("9007199254740991", True, "2^53 - 1"),
        ("1.0", False, "spelled with a fraction"),
        ("1e3", False, "in exponent form"),
        ("1E3", False, "in exponent form"),
        ("-0", False, "negative zero"),
        ("-1", False, "negative"),
        ("01", False, "with a leading zero"),
        ("9007199254740991.4", False, "a near-integer fraction"),
        ("9007199254740992", False, "2^53"),
        ("18446744073709551615", False, "2^64 - 1 (a uint64 above 2^53 - 1)"),
    ]:
        try:
            value = parse_integer(token)
        except ValueError:
            value = None
        if (value is not None) != accept:
            v.fail(f"integer token {token}")
        cases.append(
            v.case(
                f"integer-{'accept' if accept else 'reject'}-{slug(token.replace('.', 'p').replace('-', 'minus'))}",
                f"{SPEC}: JSON integer token {token} ({why})",
                {"op": "parseInteger", "json": token},
                {"value": str(value)} if accept else {"outcome": "reject"},
            )
        )

    # Cross-class equality: decode both sides, compare bytes.
    def eq(case_id, left, right, expected, why):
        """expected: "true" / "false" when both sides parse, "reject" when one does not."""
        try:
            result = "true" if decode(*left) == decode(*right) else "false"
        except ValueError:
            result = "reject"
        if result != expected:
            v.fail(f"{case_id}: unexpected")
        cases.append(
            v.case(
                f"equal-{case_id}",
                f"{SPEC}: {why}",
                {"op": "equalBytes", "a": {"path": left[0], "value": left[1]}, "b": {"path": right[0], "value": right[1]}},
                {"outcome": "reject"} if expected == "reject" else {"equal": expected},
            )
        )

    other = v.xonly_public_key(v.det("encodings/other/nostr", 32))
    eq("owner-and-card-owner-nostr", ("OwnerAction.owner", key.hex()), ("AgentCard.ownerNostr", "0x" + key.hex()), "true", "an OwnerAction owner and the card's ownerNostr for the same key are equal as bytes")
    eq("from-and-card-agent-nostr", ("envelope.from", key.hex()), ("AgentCard.agentNostr", "0x" + key.hex()), "true", "an envelope from and the card's agentNostr compare as bytes")
    eq("owner-key-and-card", ("CommitmentScope.counterparty.ownerKey", key.hex()), ("AgentCard.ownerNostr", "0x" + key.hex()), "true", "a CommitmentScope ownerKey and a card key compare as bytes")
    eq("owner-other-key", ("OwnerAction.owner", other.hex()), ("AgentCard.ownerNostr", "0x" + key.hex()), "false", "two well-formed, different keys are not equal")
    eq("owner-with-0x", ("OwnerAction.owner", "0x" + key.hex()), ("AgentCard.ownerNostr", "0x" + key.hex()), "reject", "an owner with 0x fails its parse first, though the strings are equal")
    eq("card-without-0x", ("OwnerAction.owner", key.hex()), ("AgentCard.ownerNostr", key.hex()), "reject", "a card key without 0x fails its parse first")
    eq("contact-and-card-agent-evm", ("contact.check.params.contact", address), ("AgentCard.agentEvm", address), "true", "a contact.check contact and the card's agentEvm compare as bytes")
    eq("address-checksummed", ("OwnerAction.agent", checksummed), ("AgentCard.agentEvm", address), "reject", "an EIP-55 address fails its parse; nothing lower-cases it")
    return cases


PATH = {"enum": sorted(PATH_CLASS)}
OPERAND = v.strict_object({"path": PATH, "value": v.STRING})
SCHEMA = v.case_schema(
    SUITE,
    "04 §2.4.1 canonical encodings. `decode`: the value at a schema path, decoded by that path's row, "
    "as hex bytes (uint256 as 32 big-endian bytes, approvalId as its 16 bytes), or a rejection. "
    "`parseInteger`: a JSON number token as text, its value as a decimal string, or a rejection. "
    "`equalBytes`: `equal` true or false when both values parse, or a rejection when either does "
    "not. Base64url paths have the byte length their field has (fixed, minimum, maximum, or none).",
    {
        "decode": ({"path": PATH, "value": v.STRING}, [{"bytes": v.HEX}, v.REJECT]),
        "parseInteger": ({"json": v.STRING}, [{"value": v.STRING}, v.REJECT]),
        "equalBytes": ({"a": OPERAND, "b": OPERAND}, [{"equal": {"enum": ["true", "false"]}}, v.REJECT]),
    },
)

if __name__ == "__main__":
    v.main(
        suite=SUITE,
        version=VERSION,
        script="tools/vectors/generate_encodings.py",
        libraries=["coincurve", "pycryptodome"],
        build=build,
        schema=SCHEMA,
        doc=__doc__,
    )
