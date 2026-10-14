#!/usr/bin/env python3
"""Independent generator for the `owner-action` suite: SignedOwnerAction (M1-1h, D-58).

04 §2.5.1, exactly:
  sig = BIP-340 by `owner` over taggedHash("agentlink/owner-action/v1", sha256(JCS(OwnerAction)))
JCS is Trail of Bits' `rfc8785`, BIP-340 is libsecp256k1 (coincurve). Keys, nonces and aux_rand
are synthetic test values.

Ops: `agent.revoke` (sign and verify); `approval.decide` (sign and verify against a pending
request); `approval.cancel` and `policy.set` (sign; `policy` is the 06 §3 defaults, until M1-2b
builds the strict schema). `actionDigest` is 64 lowercase hex, and the card's `ownerNostr` is
0x + 64 hex while `owner` has no prefix, compared as bytes: 04 §2.4.1 and §3.4.1. `approvalId` is exactly `apr_` + base64url of 16 bytes.

`verify` cases give the receiving core's context: the agent's own EVM address, `ownerNostr` as the
card spells it, the current time, an empty nonce store and, for `approval.decide`, the pending
request. Every rejection vector for a non-canonical
form carries a signature that is VALID over the JCS of that non-canonical body, so it can only be
refused by the encoding check (04 §2.5.1: "rejected, never normalised"). The forms are those the
card lists: checksummed or uppercase address, uppercase hex, padded base64url, out-of-range
integer, unknown key; plus a missing key, wrong types and wrong lengths. The other refusals: wrong
agent, wrong owner, another signer, the envelope tag, no tag, a body changed after signing, an
unknown op, a bad reason and expiresAt != 0 for agent.revoke.

Usage: python3 -I tools/vectors/generate_owner_action.py --check [FILE] | --write
"""

import copy
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import vectorlib as v  # noqa: E402

SUITE = "owner-action"
VERSION = 1
TAG = "agentlink/owner-action/v1"
ENVELOPE_TAG = "agentlink/envelope/v1"
SPEC = "04 §2.5.1"
ISSUED_AT = 1760000000


def jcs_lenient(value):
    """JCS for bodies that deliberately break the encoding rules. `rfc8785` refuses integers
    beyond 2^53 - 1; RFC 8785 serialises numbers as IEEE 754 doubles, which is what a JavaScript
    verifier sees, so such integers are canonicalised as doubles here."""

    def fix(x):
        if isinstance(x, bool) or not isinstance(x, (int, float, dict, list)):
            return x
        if isinstance(x, int):
            return float(x) if abs(x) > 2**53 - 1 else x
        if isinstance(x, dict):
            return {k: fix(val) for k, val in x.items()}
        if isinstance(x, list):
            return [fix(val) for val in x]
        return x

    return v.jcs(fix(value))


def body_hash(body):
    return v.sha256(jcs_lenient(body))


def sign(body, secret, aux, tag=TAG, tagged=True):
    message = v.tagged_hash(tag, body_hash(body)) if tagged else body_hash(body)
    return v.hx(v.schnorr_sign(secret, message, aux))


def build():
    owner = v.det("owner-action/owner/nostr", 32)
    other = v.det("owner-action/other-owner/nostr", 32)
    aux = v.det("owner-action/aux-rand", 32)
    owner_pub = v.hx(v.xonly_public_key(owner))
    agent = v.evm_address(v.det("owner-action/agent/evm", 32))
    other_agent = v.evm_address(v.det("owner-action/other-agent/evm", 32))
    nonce_bytes = bytes.fromhex("fbff3e0f00ff10e0f8fe7d3c1b0a99ee")  # base64url uses '-' and '_'
    nonce = v.b64u(nonce_bytes)
    if "-" not in nonce or "_" not in nonce:
        v.fail("pick a nonce whose base64url uses '-' and '_'")
    context = {"agent": agent, "ownerNostr": "0x" + owner_pub, "now": ISSUED_AT + 60}

    def body(reason="compromised", **overrides):
        b = {
            "v": 1,
            "agent": agent,
            "owner": owner_pub,
            "op": "agent.revoke",
            "params": {"reason": reason},
            "nonce": nonce,
            "issuedAt": ISSUED_AT,
            "expiresAt": 0,
        }
        b.update(overrides)
        return b

    cases = []
    for reason in ["compromised", "retired", "other"]:
        b = body(reason)
        sig = sign(b, owner, aux)
        cases.append(
            v.case(
                f"sign-revoke-{reason}",
                f"{SPEC} SignedOwnerAction, op agent.revoke",
                {"op": "sign", "body": b, "secretKey": v.hx(owner), "auxRand": v.hx(aux)},
                {
                    "jcs": jcs_lenient(b).decode("utf-8"),
                    "bodyHash": v.hx(body_hash(b)),
                    "signatureInput": v.hx(v.tagged_hash(TAG, body_hash(b))),
                    "sig": sig,
                },
            )
        )
        cases.append(
            v.case(
                f"verify-revoke-{reason}",
                f"{SPEC} verification passes (agent.revoke skips expiry and lifetime checks)",
                {"op": "verify", "signed": {"body": b, "sig": sig}, "context": context},
                {"outcome": "accept"},
            )
        )

    def reject(case_id, why, signed, ctx=context):
        cases.append(
            v.case(
                case_id,
                f"{SPEC}: {why}; rejected, never normalised",
                {"op": "verify", "signed": signed, "context": ctx},
                {"outcome": "reject"},
            )
        )

    def signed_body(b):
        return {"body": b, "sig": sign(b, owner, aux)}

    good = body()
    good_sig = sign(good, owner, aux)

    # Non-canonical encodings, each validly signed.
    reject("reject-agent-checksummed", "`agent` in EIP-55 mixed case", signed_body(body(agent=v.eip55(agent))))
    reject("reject-agent-uppercase-hex", "`agent` hex digits in upper case", signed_body(body(agent="0x" + agent[2:].upper())))
    reject("reject-agent-uppercase-prefix", "`agent` with a 0X prefix", signed_body(body(agent="0X" + agent[2:])))
    reject("reject-agent-no-prefix", "`agent` without 0x", signed_body(body(agent=agent[2:])))
    reject("reject-agent-short", "`agent` with 39 hex digits", signed_body(body(agent=agent[:-1])))
    reject("reject-owner-uppercase-hex", "`owner` hex digits in upper case", signed_body(body(owner=owner_pub.upper())))
    reject("reject-owner-0x-prefix", "`owner` with a 0x prefix, i.e. spelled as the card spells ownerNostr (§2.4.1)",signed_body(body(owner="0x" + owner_pub)))
    reject("reject-sig-uppercase-hex", "`sig` hex digits in upper case (the signature is otherwise valid)", {"body": good, "sig": good_sig.upper()})
    reject("reject-sig-short", "`sig` of 127 hex digits", {"body": good, "sig": good_sig[:-1]})
    reject("reject-sig-0x-prefix", "`sig` with a 0x prefix (Nostr-native, §2.4.1)", {"body": good, "sig": "0x" + good_sig})
    reject("reject-nonce-padded", "`nonce` base64url with padding", signed_body(body(nonce=nonce + "==")))
    reject("reject-nonce-standard-alphabet", "`nonce` in the standard base64 alphabet ('+', '/')", signed_body(body(nonce=nonce.replace("-", "+").replace("_", "/"))))
    last = nonce[-1]
    alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    sloppy = nonce[:-1] + alphabet[alphabet.index(last) | 1]  # 22 chars carry 132 bits; 4 must be 0
    if sloppy == nonce:
        v.fail("non-canonical nonce equals the canonical one")
    reject("reject-nonce-nonzero-trailing-bits", "`nonce` with non-zero trailing bits (decodes to the same 16 bytes)", signed_body(body(nonce=sloppy)))
    reject("reject-nonce-15-bytes", "`nonce` of 15 bytes", signed_body(body(nonce=v.b64u(nonce_bytes[:15]))))
    reject("reject-nonce-17-bytes", "`nonce` of 17 bytes", signed_body(body(nonce=v.b64u(nonce_bytes + b"\x00"))))
    reject("reject-issued-at-2-pow-53", "`issuedAt` = 2^53, outside [0, 2^53 - 1]", signed_body(body(issuedAt=2**53)))
    reject("reject-issued-at-negative", "`issuedAt` = -1, outside [0, 2^53 - 1]", signed_body(body(issuedAt=-1)))
    reject("reject-issued-at-fraction", "`issuedAt` not an integer", signed_body(body(issuedAt=ISSUED_AT + 0.5)))
    reject("reject-issued-at-string", "`issuedAt` as a string", signed_body(body(issuedAt=str(ISSUED_AT))))
    reject("reject-v-string", "`v` as a string", signed_body(body(v="1")))
    reject("reject-v-2", "`v` other than 1", signed_body(body(v=2)))
    unknown_top = {"body": good, "sig": good_sig, "note": "x"}
    reject("reject-unknown-key-signed-owner-action", "unknown key in SignedOwnerAction", unknown_top)
    reject("reject-unknown-key-owner-action", "unknown key in OwnerAction", signed_body(body(memo="x")))
    unknown_params = body()
    unknown_params["params"] = {"reason": "compromised", "detail": "x"}
    reject("reject-unknown-key-params", "unknown key in params", signed_body(unknown_params))
    missing_nonce = body()
    del missing_nonce["nonce"]
    reject("reject-missing-nonce", "required key `nonce` missing", signed_body(missing_nonce))
    reject("reject-reason-free-text", "`reason` outside the fixed values", signed_body(body(reason="hacked")))
    reject("reject-revoke-expiry-nonzero", "agent.revoke requires expiresAt = 0", signed_body(body(expiresAt=ISSUED_AT + 600)))
    reject("reject-unknown-op", "unknown `op`", signed_body(body(op="agent.unrevoke")))

    # Binding and signature failures, with a canonical body.
    reject("reject-wrong-agent", "`agent` is not this agent's EVM address", signed_body(body(agent=other_agent)))
    reject("reject-wrong-owner", "`owner` differs from ownerNostr in the agent's card", {"body": body(owner=v.hx(v.xonly_public_key(other))), "sig": sign(body(owner=v.hx(v.xonly_public_key(other))), other, aux)})
    reject("reject-other-signer", "signed by another key than `owner`", {"body": good, "sig": sign(good, other, aux)})
    reject("reject-envelope-tag", "signed under agentlink/envelope/v1", {"body": good, "sig": sign(good, owner, aux, tag=ENVELOPE_TAG)})
    reject("reject-untagged", "signed over sha256(JCS(body)) without the tag", {"body": good, "sig": sign(good, owner, aux, tagged=False)})
    changed = copy.deepcopy(good)
    changed["params"]["reason"] = "retired"
    reject("reject-body-changed", "body changed after signing", {"body": changed, "sig": good_sig})

    # approval.decide, approval.cancel and policy.set (04 §2.5.1, §3.4.1, §2.4.1).
    approval_id = "apr_" + v.b64u(v.det("owner-action/approval-id", 16))
    action = {"tool": "agentlink_respond_to_terms", "args": {"contact": other_agent, "decision": "accept"}, "context": {}}
    digest = v.hx(v.sha256(v.jcs(action)))
    request_expires = ISSUED_AT + 86400
    pending = {"approvalId": approval_id, "actionDigest": digest, "expiresAt": request_expires}
    decide_ctx = {**context, "pendingApproval": pending}

    def op_body(op, params, expires_at=ISSUED_AT + 600, **overrides):
        return body(op=op, params=params, expiresAt=expires_at, **overrides)

    policy = {
        "contacts": {"acceptInvites": "approval", "unknownSenders": "queue", "allowed": "paired", "rateLimitPerContactPerHour": 120},
        "files": {
            "allowedFolders": [],
            "inboxFolder": "~/AgentLink/Inbox",
            "maxSendSizeMB": 100,
            "maxReceiveSizeMB": 200,
            "storage": "auto",
            "defaultExpiryDays": 7,
            "deleteAfter": "expiry",
            "ownerArchive": False,
        },
        "envelopes": {"maxEnvelopeKB": 24},
        "proofs": {"notarize": "allow", "dailyBudgetUSD": 5, "perActionMaxUSD": 1, "allowKeyDisclosure": "approval", "exportFolder": "~/AgentLink/Proofs", "defaultChain": "base"},
        "receipts": {"autoDelivered": True, "autoOpened": False},
        "commitments": {"accept": "approval", "autoAcceptContacts": [], "autoAcceptMaxUSD": 0, "autoAcceptDirection": "buy", "autoAcceptMinUSD": None},
    }
    for case_id, why, b in [
        ("sign-approval-approve", "approval.decide, approve", op_body("approval.decide", {"approvalId": approval_id, "actionDigest": digest, "decision": "approve"})),
        ("sign-approval-deny", "approval.decide, deny (a deny is signed too)", op_body("approval.decide", {"approvalId": approval_id, "actionDigest": digest, "decision": "deny"})),
        ("sign-approval-cancel", "approval.cancel (D-55)", op_body("approval.cancel", {"approvalId": approval_id})),
        ("sign-policy-set", "policy.set with the 06 §3 defaults as policy (proposed until M1-2b)", op_body("policy.set", {"version": 1, "policy": policy})),
    ]:
        cases.append(
            v.case(
                case_id,
                f"{SPEC} SignedOwnerAction, {why}",
                {"op": "sign", "body": b, "secretKey": v.hx(owner), "auxRand": v.hx(aux)},
                {
                    "jcs": jcs_lenient(b).decode("utf-8"),
                    "bodyHash": v.hx(body_hash(b)),
                    "signatureInput": v.hx(v.tagged_hash(TAG, body_hash(b))),
                    "sig": sign(b, owner, aux),
                },
            )
        )

    def decide(**params):
        p_ = {"approvalId": approval_id, "actionDigest": digest, "decision": "approve"}
        p_.update(params)
        return p_

    approve = op_body("approval.decide", decide())
    cases.append(
        v.case(
            "verify-approval-approve",
            f"{SPEC}: approval.decide for the pending request verifies",
            {"op": "verify", "signed": signed_body(approve), "context": decide_ctx},
            {"outcome": "accept"},
        )
    )
    for case_id, why, b in [
        ("reject-digest-0x-prefix", "`actionDigest` with a 0x prefix (bare hex, §2.4.1)", op_body("approval.decide", decide(actionDigest="0x" + digest))),
        ("reject-digest-uppercase", "`actionDigest` in upper-case hex", op_body("approval.decide", decide(actionDigest=digest.upper()))),
        ("reject-digest-base64url", "`actionDigest` as base64url", op_body("approval.decide", decide(actionDigest=v.b64u(bytes.fromhex(digest))))),
        ("reject-digest-mismatch", "`actionDigest` of another action", op_body("approval.decide", decide(actionDigest=v.hx(v.sha256(b"other"))))),
        ("reject-approval-id-unknown", "an approvalId that is not pending", op_body("approval.decide", decide(approvalId="apr_" + v.b64u(v.det("owner-action/other-approval", 16))))),
        ("reject-approval-id-no-prefix", "approvalId without apr_", op_body("approval.decide", decide(approvalId=approval_id[4:]))),
        ("reject-approval-id-padded", "approvalId with padded base64url", op_body("approval.decide", decide(approvalId=approval_id + "=="))),
        ("reject-decision-free-text", "`decision` outside approve | deny", op_body("approval.decide", decide(decision="maybe"))),
        ("reject-decide-unknown-param", "unknown key in approval.decide params", op_body("approval.decide", {**decide(), "note": "x"})),
        ("reject-decide-expiry-zero", "expiresAt = 0 is allowed only for agent.revoke", op_body("approval.decide", decide(), expires_at=0)),
        ("reject-decide-beyond-request", "expiresAt after the request's expiresAt (its maximum lifetime)", op_body("approval.decide", decide(), expires_at=request_expires + 1)),
        ("reject-decide-expired", "now is after expiresAt", op_body("approval.decide", decide(), expires_at=ISSUED_AT + 30)),
    ]:
        reject(case_id, why, signed_body(b), decide_ctx)

    # contact.check (04 §2.5.1, §3.6.1; G-28): {contact, pairingDigest}. Its maximum lifetime is
    # G-7's, so only signing and encoding rejections are vectored (no positive verify yet).
    pairing_digest = v.hx(v.sha256(b"owner-action/pairing-digest"))
    pairing_ctx = {**context, "pairing": {"contact": other_agent, "pairingDigest": pairing_digest}}

    def check(**params):
        p_ = {"contact": other_agent, "pairingDigest": pairing_digest}
        p_.update(params)
        return op_body("contact.check", p_)

    b = check()
    cases.append(
        v.case(
            "sign-contact-check",
            f"{SPEC} SignedOwnerAction, contact.check (04 §3.6.1)",
            {"op": "sign", "body": b, "secretKey": v.hx(owner), "auxRand": v.hx(aux)},
            {
                "jcs": jcs_lenient(b).decode("utf-8"),
                "bodyHash": v.hx(body_hash(b)),
                "signatureInput": v.hx(v.tagged_hash(TAG, body_hash(b))),
                "sig": sign(b, owner, aux),
            },
        )
    )
    for case_id, why, bad in [
        ("reject-pairing-digest-0x", "`pairingDigest` with 0x (bare hex, 04 §2.4.1)", check(pairingDigest="0x" + pairing_digest)),
        ("reject-pairing-digest-uppercase", "`pairingDigest` in upper-case hex", check(pairingDigest=pairing_digest.upper())),
        ("reject-pairing-digest-base64url", "`pairingDigest` as base64url", check(pairingDigest=v.b64u(bytes.fromhex(pairing_digest)))),
        ("reject-contact-checksummed", "`contact` in EIP-55 mixed case", check(contact=v.eip55(other_agent))),
        ("reject-contact-check-unknown-param", "unknown key in contact.check params", op_body("contact.check", {"contact": other_agent, "pairingDigest": pairing_digest, "note": "x"})),
    ]:
        reject(case_id, why, signed_body(bad), pairing_ctx)

    # Raw JSON text (04 §2.4.1: integer tokens must match 0|[1-9][0-9]*, checked on the token; I-JSON
    # refuses duplicate keys). Each signature is valid over the JCS of the parsed value, so only the
    # token or duplicate check can refuse it (IR-M1-1h-2 F-D).
    good_signed = {"body": good, "sig": good_sig}
    text = json.dumps(good_signed, separators=(",", ":"))
    cases.append(v.case("verify-json-revoke", f"{SPEC}: the SignedOwnerAction as JSON text verifies", {"op": "verifyJson", "json": text, "context": context}, {"outcome": "accept"}))
    for case_id, why, old, new in [
        ("issued-at-fraction", "issuedAt spelled 1760000000.0", '"issuedAt":1760000000', '"issuedAt":1760000000.0'),
        ("issued-at-exponent", "issuedAt spelled 1.76e9", '"issuedAt":1760000000', '"issuedAt":1.76e9'),
        ("v-fraction", "v spelled 1.0", '"v":1', '"v":1.0'),
        ("expires-at-minus-zero", "expiresAt spelled -0", '"expiresAt":0', '"expiresAt":-0'),
        ("duplicate-op", "a duplicate `op` key", '"op":"agent.revoke"', '"op":"agent.revoke","op":"agent.revoke"'),
    ]:
        if old not in text:
            v.fail(f"{case_id}: substitution")
        cases.append(
            v.case(
                f"verify-json-reject-{case_id}",
                f"{SPEC}, 04 §2.4.1: {why}; the signature is valid over the parsed value, so only the token check refuses it",
                {"op": "verifyJson", "json": text.replace(old, new, 1), "context": context},
                {"outcome": "reject"},
            )
        )
    return cases


CONTEXT = {
    "type": "object",
    "additionalProperties": False,
    "required": ["agent", "ownerNostr", "now"],
    "properties": {
        "agent": v.ADDRESS,
        "ownerNostr": {"type": "string", "pattern": "^0x[0-9a-f]{64}$"},
        "now": v.INTEGER,
        "pendingApproval": v.strict_object({"approvalId": v.STRING, "actionDigest": v.hexn(32), "expiresAt": v.INTEGER}),
        "pairing": v.strict_object({"contact": v.ADDRESS, "pairingDigest": v.hexn(32)}),
    },
}
SCHEMA = v.case_schema(
    SUITE,
    "04 §2.5.1 SignedOwnerAction. `sign`: JCS text, sha256 body hash, tagged signature input and "
    "sig for a body. `verify`: accept or reject a SignedOwnerAction for a receiving core whose "
    "agent address, card ownerNostr and clock are given in `context` (nonce store empty).",
    {
        "sign": (
            {"body": v.OBJECT, "secretKey": v.hexn(32), "auxRand": v.hexn(32)},
            [{"jcs": v.STRING, "bodyHash": v.hexn(32), "signatureInput": v.hexn(32), "sig": v.hexn(64)}],
        ),
        "verify": ({"signed": v.OBJECT, "context": CONTEXT}, [v.ACCEPT, v.REJECT]),
        "verifyJson": ({"json": v.STRING, "context": CONTEXT}, [v.ACCEPT, v.REJECT]),
    },
)

if __name__ == "__main__":
    v.main(
        suite=SUITE,
        version=VERSION,
        script="tools/vectors/generate_owner_action.py",
        libraries=["coincurve", "pycryptodome", "rfc8785"],
        build=build,
        schema=SCHEMA,
        doc=__doc__,
    )
