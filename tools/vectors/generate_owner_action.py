#!/usr/bin/env python3
"""Independent generator for the `owner-action` suite: SignedOwnerAction (M1-1h, D-58).

04 §2.5.1, exactly:
  sig = BIP-340 by `owner` over taggedHash("agentlink/owner-action/v1", sha256(JCS(OwnerAction)))
JCS is Trail of Bits' `rfc8785`, BIP-340 is libsecp256k1 (coincurve). Keys, nonces and aux_rand
are synthetic test values.

Ops: `agent.revoke` (sign and verify); `approval.decide` (sign and verify against a pending
request); `approval.cancel` (sign); `policy.set` (sign, verify and reject: the policy is the 06 §3
"Policy JSON form", G-32). Its signing vectors are the 06 §3 defaults in that JSON form (USD limits as
decimal strings, `contactRules: []`) and one policy with two `contactRules`, written here in
non-JCS key order and sorted by `contact`. Its rejection vectors are the pre-G-32 form this file
carried in version 1 (JSON-number USD, no `contactRules`) and one schema violation each; the
policy is written here by hand from 06 §3, never taken from `@4thtech-io/types`. Its verify vectors
accept a `version` above the highest applied one and reject an equal or lower one (04 §2.5.1
rollback rule); the context's optional `appliedPolicyVersion` is that highest applied version, and
an absent value means 0, no policy applied yet (06 §3). `actionDigest` is 64 lowercase hex, and the card's `ownerNostr` is
0x + 64 hex while `owner` has no prefix, compared as bytes: 04 §2.4.1 and §3.4.1. `approvalId` is exactly `apr_` + base64url of 16 bytes.

`verify` cases give the receiving core's context: the agent's own EVM address, `ownerNostr` as the
card spells it, the current time, an empty nonce store, for `approval.decide` the pending
request and, for `policy.set`, the highest applied policy version (absent = 0). Every rejection vector for a non-canonical
form carries a signature that is VALID over the JCS of that non-canonical body, so it can only be
refused by the encoding check (04 §2.5.1: "rejected, never normalised"). The forms are those the
card lists: checksummed or uppercase address, uppercase hex, padded base64url, out-of-range
integer, unknown key; plus a missing key, wrong types and wrong lengths. The other refusals: wrong
agent, wrong owner, another signer, the envelope tag, no tag, a body changed after signing, an
unknown op, a bad reason and expiresAt != 0 for agent.revoke.

`approval.decideBatch` (D-68, 04 §2.5.2), version 3: signing and verify vectors for batches of 2
and 20 items with mixed decisions, in strictly ascending `approvalId` order compared as bytes (the
2-item pair is ordered differently case-insensitively); rejection vectors, each validly signed, for
0, 1 and 21 items, unsorted items, a duplicate item and a duplicate `approvalId`, an unknown key in
an item or in params, an upper-case or `0x` item `actionDigest`, and a batch body carrying
`approval.decide` params and the reverse. The verify context's `pendingApprovals` holds every
request the batches name, each expiring after the batch.

`contact.check` (G-28; 04 §2.5.1, §3.6.1; 07 §3 `contacts.safety_check`), version 4: the verify
context's `pairings` holds each completed pairing as the core stores it: the contact's agent ID,
its current card, and the signed `handshake` H and `handshake-ack` K as envelopes with their CEKs.
The verifier recomputes `pairingDigest` from H and K (04 §3.6.1 steps 1-5, the
`safety-code-recompute` reference) and never reads a stored digest. The agent under test is the
inviter: its card is built here from the context's own agent and owner keys, and it signed K. Accept
cases: a valid check, and one verified exactly at `expiresAt`. Rejections (each validly signed by
the owner unless stated): `contact` in upper case; a `pairingDigest` that is not the recomputed one
(the role-swapped digest); another signer; expired by one second; a lifetime of 86 401 s (L = 86 400,
G-7); an unknown contact; a stored pair whose K signature no longer verifies; and, as in version 3,
the encoding rejections. `reference_verify_contact_check` is this generator's own reading of the
04 §2.5.1 checks, and every contact.check verify case is asserted against it.

`contact.rename` and `contact.remove` (M1-9za; 04 §2.5.1, proposed), version 5: params exactly
`{contact, alias}` and `{contact}`; `alias` is 1 to 32 code points; L(op) = 600 s. Sign vectors for
both ops (one alias with a non-ASCII letter, so the JCS text carries UTF-8). Verify accept cases
for both, and one at exactly `expiresAt`. Rejections, each validly signed unless stated: a lifetime
of 601 s; `contact` in upper case or EIP-55 case; an empty alias; an alias of 33 code points; an
unknown params key; remove carrying an `alias`; another signer. The store rules (a stored contact,
the alias being its own restricted form and unique, a revoked contact refused) are the core's, not
these vectors'.

Usage: python3 -I tools/vectors/generate_owner_action.py --check [FILE] | --write
"""

import copy
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import generate_aead_envelope as env  # noqa: E402
import generate_eip712 as eip712  # noqa: E402
import generate_pairing as pairing  # noqa: E402
import generate_pairing_bodies as bodies  # noqa: E402
import generate_safety_code as safety  # noqa: E402
import vectorlib as v  # noqa: E402

SUITE = "owner-action"
VERSION = 6
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

    def reject(case_id, why, signed, ctx=context, spec=SPEC):
        cases.append(
            v.case(
                case_id,
                f"{spec}: {why}; rejected, never normalised",
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

    # 06 §3 defaults in the policy JSON form (G-32): every key, USD limits as USD amount strings
    # (04 §2.4.1), empty contact lists, `autoAcceptMinUSD: null` and `contactRules: []`.
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
        "proofs": {"notarize": "allow", "dailyBudgetUSD": "5", "perActionMaxUSD": "1", "allowKeyDisclosure": "approval", "exportFolder": "~/AgentLink/Proofs", "defaultChain": "base"},
        # D-109 (M1-33a, owner-action version 6): delivery receipts are off by default.
        "receipts": {"autoDelivered": False, "autoOpened": False},
        "commitments": {"accept": "approval", "autoAcceptContacts": [], "autoAcceptMaxUSD": "0", "autoAcceptDirection": "buy", "autoAcceptMinUSD": None},
        "contactRules": [],
    }

    # Two per-contact rules (06 §3 "Per-contact rules"). Keys are written out of JCS order on
    # purpose, and the list is sorted by `contact` in strictly ascending byte order.
    third_agent = v.evm_address(v.det("owner-action/third-agent/evm", 32))
    rule_contacts = sorted([other_agent, third_agent])
    if rule_contacts[0] == rule_contacts[1]:
        v.fail("the two rule contacts must differ")
    rules = [
        {"proofs": {"perActionMaxUSD": "2.5", "notarize": "allow"}, "contact": rule_contacts[0]},
        {"proofs": {"perActionMaxUSD": "0.01"}, "contact": rule_contacts[1]},
    ]
    policy_with_rules = copy.deepcopy(policy)
    policy_with_rules["contactRules"] = rules
    # A receipts-only rule (06 §3, D-109): `receipts` without `proofs` turns DELIVERED on for one contact.
    policy_with_receipts_rule = copy.deepcopy(policy)
    policy_with_receipts_rule["contactRules"] = [{"receipts": {"autoDelivered": True}, "contact": rule_contacts[0]}]
    if [r["contact"] for r in rules] != sorted({r["contact"] for r in rules}):
        v.fail("contactRules must be sorted and unique")
    for case_id, why, b in [
        ("sign-approval-approve", "approval.decide, approve", op_body("approval.decide", {"approvalId": approval_id, "actionDigest": digest, "decision": "approve"})),
        ("sign-approval-deny", "approval.decide, deny (a deny is signed too)", op_body("approval.decide", {"approvalId": approval_id, "actionDigest": digest, "decision": "deny"})),
        ("sign-approval-cancel", "approval.cancel (D-55)", op_body("approval.cancel", {"approvalId": approval_id})),
        ("sign-policy-set", "policy.set with the 06 §3 defaults in the policy JSON form as policy (G-32)", op_body("policy.set", {"version": 1, "policy": policy})),
        ("sign-policy-set-contact-rules", "policy.set with two contactRules, sorted by contact, in JCS key order once canonicalised (06 §3, G-32)", op_body("policy.set", {"version": 2, "policy": policy_with_rules})),
        ("sign-policy-set-receipts-rule", "policy.set with a ContactRule that has `receipts` and no `proofs` (06 §3, D-109)", op_body("policy.set", {"version": 3, "policy": policy_with_receipts_rule})),
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

    # approval.decideBatch (D-68; 04 §2.5.1, §2.5.2): {items: [...]}, 2 to BATCH_MAX items, each
    # exactly the approval.decide params, in strictly ascending approvalId order compared as bytes.
    # Written here from 04 §2.5.2, never taken from `@4thtech-io/types`. The context lists every
    # pending request the batches below name (`pendingApprovals`), each expiring well after the
    # batch, so a rejection vector can only be refused for the defect its id names.
    batch_spec = "04 §2.5.1, §2.5.2 (D-68)"
    batch_max = 20
    requests = []
    for i in range(batch_max + 1):
        a = {"tool": "agentlink_send_message", "args": {"contact": other_agent, "text": f"batch request {i}"}, "context": {}}
        requests.append(
            {
                "approvalId": "apr_" + v.b64u(v.det(f"owner-action/batch/approval-id/{i}", 16)),
                "actionDigest": v.hx(v.sha256(v.jcs(a))),
                "expiresAt": ISSUED_AT + 3600 * (1 + i % 24),
            }
        )

    def id_bytes(r):
        return r["approvalId"].encode("ascii")

    requests.sort(key=id_bytes)
    if len({id_bytes(r) for r in requests}) != len(requests):
        v.fail("batch approvalIds must be unique")
    batch_ctx = {**context, "pendingApprovals": requests}
    batch_expires = ISSUED_AT + 600  # the CLI and local UI bound (04 §2.5.2), below every request's expiresAt
    if batch_expires > min(r["expiresAt"] for r in requests):
        v.fail("batch expiresAt must not exceed the earliest request's expiresAt")

    def item(r, decision):
        return {"approvalId": r["approvalId"], "actionDigest": r["actionDigest"], "decision": decision}

    def items_of(reqs):
        # Mixed decisions: every third item is a deny.
        return [item(r, "deny" if k % 3 == 1 else "approve") for k, r in enumerate(reqs)]

    def batch_body(items, **overrides):
        return op_body("approval.decideBatch", {"items": items}, expires_at=batch_expires, **overrides)

    # The 2-item batch is a pair whose byte order differs from a case-insensitive order (an upper-case
    # or '_' character against a lower-case one), so a verifier that sorts with locale or
    # case-folding rules refuses the canonical form and accepts the reversed one.
    def folded(r):
        return r["approvalId"].lower().encode("ascii")

    pair = next(
        ((x, y) for n, x in enumerate(requests) for y in requests[n + 1 :] if folded(x) > folded(y)),
        None,
    )
    if pair is None:
        v.fail("no approvalId pair whose byte order differs from the case-insensitive order")
    items2 = items_of(list(pair))
    items20 = items_of(requests[:batch_max])
    if [i_["decision"] for i_ in items2] != ["approve", "deny"] or len({i_["decision"] for i_ in items20}) != 2:
        v.fail("batch signing vectors must carry mixed decisions")
    for case_id, why, b in [
        ("sign-batch-2", "approval.decideBatch with 2 items (the minimum), approve and deny, ascending approvalId by bytes", batch_body(items2)),
        ("sign-batch-20", f"approval.decideBatch with {batch_max} items (the maximum), mixed decisions", batch_body(items20)),
    ]:
        cases.append(
            v.case(
                case_id,
                f"{batch_spec} SignedOwnerAction, {why}",
                {"op": "sign", "body": b, "secretKey": v.hx(owner), "auxRand": v.hx(aux)},
                {
                    "jcs": jcs_lenient(b).decode("utf-8"),
                    "bodyHash": v.hx(body_hash(b)),
                    "signatureInput": v.hx(v.tagged_hash(TAG, body_hash(b))),
                    "sig": sign(b, owner, aux),
                },
            )
        )
    for case_id, why, items in [
        ("verify-batch-2", "a 2-item batch of pending requests verifies", items2),
        ("verify-batch-20", f"a {batch_max}-item batch of pending requests verifies", items20),
    ]:
        cases.append(
            v.case(
                case_id,
                f"{batch_spec}: {why}",
                {"op": "verify", "signed": signed_body(batch_body(items)), "context": batch_ctx},
                {"outcome": "accept"},
            )
        )

    def with_item(items, k, **fields):
        out = copy.deepcopy(items)
        out[k].update(fields)
        return out

    swapped20 = copy.deepcopy(items20)
    swapped20[9], swapped20[10] = swapped20[10], swapped20[9]
    first = requests[0]
    duplicate_same = [item(first, "approve"), item(first, "approve")]
    duplicate_decisions = [item(first, "approve"), item(first, "deny")]
    single_decide = {"approvalId": first["approvalId"], "actionDigest": first["actionDigest"], "decision": "approve"}
    for case_id, why, b, ctx in [
        ("reject-batch-1-item", "a batch of 1 item (one decision is always an approval.decide)", batch_body(items_of(requests[:1])), batch_ctx),
        ("reject-batch-21-items", f"a batch of {batch_max + 1} items (above the maximum of {batch_max})", batch_body(items_of(requests)), batch_ctx),
        ("reject-batch-0-items", "a batch with an empty `items`", batch_body([]), batch_ctx),
        ("reject-batch-unsorted", "the 2 items in descending approvalId order (they are in ascending order case-insensitively)", batch_body(list(reversed(items2))), batch_ctx),
        ("reject-batch-unsorted-middle", "items 10 and 11 of a 20-item batch swapped", batch_body(swapped20), batch_ctx),
        ("reject-batch-duplicate-item", "the same item twice", batch_body(duplicate_same), batch_ctx),
        ("reject-batch-duplicate-approval-id", "one approvalId twice, approved and denied", batch_body(duplicate_decisions), batch_ctx),
        ("reject-batch-item-unknown-key", "an unknown key in an item", batch_body(with_item(items2, 1, note="x")), batch_ctx),
        ("reject-batch-params-unknown-key", "an unknown key next to `items` in params", op_body("approval.decideBatch", {"items": items2, "note": "x"}, expires_at=batch_expires), batch_ctx),
        ("reject-batch-digest-uppercase", "an item's `actionDigest` in upper-case hex", batch_body(with_item(items2, 0, actionDigest=items2[0]["actionDigest"].upper())), batch_ctx),
        ("reject-batch-digest-0x-prefix", "an item's `actionDigest` with a 0x prefix (bare hex, §2.4.1)", batch_body(with_item(items2, 1, actionDigest="0x" + items2[1]["actionDigest"])), batch_ctx),
        ("reject-batch-with-decide-params", "op approval.decideBatch carrying approval.decide params", op_body("approval.decideBatch", single_decide, expires_at=batch_expires), batch_ctx),
        ("reject-decide-with-batch-params", "op approval.decide carrying approval.decideBatch params", op_body("approval.decide", {"items": items2}), {**batch_ctx, "pendingApproval": {k: first[k] for k in ("approvalId", "actionDigest", "expiresAt")}}),
    ]:
        reject(case_id, why, signed_body(b), ctx, spec=batch_spec)

    # policy.set schema rejections (06 §3 "Policy JSON form", G-32; 04 §2.5.1 "params match the
    # op's schema"). Each policy breaks one rule and is validly signed, so only the schema refuses it.
    def policy_edit(base, path, value=None, delete=False):
        p_ = copy.deepcopy(base)
        node = p_
        for key in path[:-1]:
            node = node[key]
        if delete:
            del node[path[-1]]
        else:
            node[path[-1]] = value
        return p_

    pre_g32 = policy_edit(policy, ["contactRules"], delete=True)
    pre_g32["proofs"]["dailyBudgetUSD"] = 5
    pre_g32["proofs"]["perActionMaxUSD"] = 1
    pre_g32["commitments"]["autoAcceptMaxUSD"] = 0
    unsorted_contacts = list(reversed(rule_contacts))
    for case_id, why, bad in [
        ("pre-g32-form", "the pre-G-32 policy (owner-action version 1: USD limits as JSON numbers, no contactRules)", pre_g32),
        ("usd-number", "`proofs.dailyBudgetUSD` as the JSON number 5", policy_edit(policy, ["proofs", "dailyBudgetUSD"], 5)),
        ("usd-trailing-zeros", "`proofs.dailyBudgetUSD` \"5.00\" (a trailing zero, 04 §2.4.1)", policy_edit(policy, ["proofs", "dailyBudgetUSD"], "5.00")),
        ("usd-seven-decimals", "`proofs.perActionMaxUSD` \"5.0000001\" (more than 6 decimals)", policy_edit(policy, ["proofs", "perActionMaxUSD"], "5.0000001")),
        ("unsorted-auto-accept-contacts", "`commitments.autoAcceptContacts` not sorted", policy_edit(policy, ["commitments", "autoAcceptContacts"], unsorted_contacts)),
        ("unsorted-contact-rules", "`contactRules` not sorted by contact", policy_edit(policy, ["contactRules"], list(reversed(rules)))),
        ("duplicate-contact-rule", "two `contactRules` for one contact", policy_edit(policy, ["contactRules"], [rules[0], {"contact": rules[0]["contact"], "proofs": {"notarize": "deny"}}])),
        ("contact-rule-empty-proofs", "a ContactRule with `proofs: {}`", policy_edit(policy, ["contactRules"], [{"contact": rule_contacts[0], "proofs": {}}])),
        ("contact-rule-unknown-key", "an unknown key in a ContactRule", policy_edit(policy, ["contactRules"], [{"contact": rule_contacts[0], "proofs": {"notarize": "allow"}, "note": "x"}])),
        ("contact-rule-no-part", "a ContactRule with neither `proofs` nor `receipts` (D-109)", policy_edit(policy, ["contactRules"], [{"contact": rule_contacts[0]}])),
        ("contact-rule-empty-receipts", "a ContactRule with `receipts: {}` (D-109)", policy_edit(policy, ["contactRules"], [{"contact": rule_contacts[0], "receipts": {}}])),
        ("contact-rule-receipts-opened", "a ContactRule `receipts` with `autoOpened` (only DELIVERED, D-109)", policy_edit(policy, ["contactRules"], [{"contact": rule_contacts[0], "receipts": {"autoDelivered": True, "autoOpened": True}}])),
        ("missing-key", "`files.storage` missing (never filled from a default)", policy_edit(policy, ["files", "storage"], delete=True)),
    ]:
        reject(f"reject-policy-set-{case_id}", f"policy.set: {why}", signed_body(op_body("policy.set", {"version": 1, "policy": bad})))

    # policy.set verification and the version rule (04 §2.5.1: `version` must be greater than the
    # highest applied version, so an older signed policy cannot be replayed to roll back). The
    # context's `appliedPolicyVersion` is that version; absent means 0, no policy applied (06 §3).
    for case_id, why, version, applied_version, pol, outcome in [
        ("verify-policy-set", "the 06 §3 defaults as version 1, no policy applied yet (appliedPolicyVersion absent = 0)", 1, None, policy, "accept"),
        ("verify-policy-set-contact-rules", "the policy with two contactRules as version 2 over applied version 1", 2, 1, policy_with_rules, "accept"),
        ("reject-policy-set-version-equal", "`version` 2 equal to the applied version 2 (rollback rule)", 2, 2, policy_with_rules, "reject"),
        ("reject-policy-set-version-lower", "`version` 1 below the applied version 2 (rollback rule)", 1, 2, policy, "reject"),
    ]:
        ctx = dict(context) if applied_version is None else {**context, "appliedPolicyVersion": applied_version}
        verdict = "verification passes" if outcome == "accept" else "rejected"
        cases.append(
            v.case(
                case_id,
                f"{SPEC}: policy.set, {why}; {verdict}",
                {"op": "verify", "signed": signed_body(op_body("policy.set", {"version": version, "policy": pol})), "context": ctx},
                {"outcome": outcome},
            )
        )

    # contact.check (04 §2.5.1, §3.6.1; G-28; 07 §3 contacts.safety_check): {contact, pairingDigest}.
    # The pairing behind it: the agent under test (A, the inviter) and the contact (B, other_agent),
    # with H (B -> A) and K (A -> B) as signed envelopes. pairingDigest is recomputed from them.
    a = keyed_party(
        "Agent A",
        {"agentEvm": "owner-action/agent/evm", "agentNostr": "owner-action/agent/nostr", "agentEnc": "owner-action/agent/enc",
         "ownerEvm": "owner-action/owner/evm", "ownerNostr": "owner-action/owner/nostr", "ownerEnc": "owner-action/owner/enc"},
        bodies.RELAYS_A,
    )
    b = keyed_party(
        "Contact B",
        {"agentEvm": "owner-action/other-agent/evm", "agentNostr": "owner-action/other-agent/nostr", "agentEnc": "owner-action/other-agent/enc",
         "ownerEvm": "owner-action/other-owner/evm", "ownerNostr": "owner-action/other-owner/nostr", "ownerEnc": "owner-action/other-owner/enc"},
        bodies.RELAYS_B,
    )
    if a["card"]["agentEvm"] != agent or a["card"]["ownerNostr"] != "0x" + owner_pub or b["card"]["agentEvm"] != other_agent:
        v.fail("the pairing cards do not match the owner-action keys")
    invite_id = v.det("owner-action/pairing/invite-id", 16)
    secret = v.det("owner-action/pairing/secret", 32)
    nonce_a = v.det("owner-action/pairing/nonce-a", 32)
    nonce_b = v.det("owner-action/pairing/nonce-b", 32)
    recipients = [v.x25519_public_key(x) for x in (a["enc"][0], a["enc"][1], b["enc"][1], b["enc"][0])]
    h_item = safety.envelope(b["nostr"], recipients, "handshake", bodies.handshake_of(a, b, invite_id, secret, nonce_a, nonce_b), "owner-action-h")
    h_env = h_item["envelope"]
    k_item = safety.envelope(a["nostr"], recipients, "handshake-ack", bodies.ack_of(a, invite_id, v.unb64u(h_env["id"]), env.envelope_hash(h_env), nonce_a), "owner-action-k")
    digest_bytes, _ = safety.recompute(agent, b["card"], h_item, k_item)
    pairing_digest = digest_bytes.hex()
    swapped = safety.code_of(safety.transcript(b["card"], a["card"], invite_id, nonce_a, nonce_b))[0].hex()
    if swapped == pairing_digest:
        v.fail("role swap gives the same digest")
    stored = {"contact": other_agent, "contactCard": b["card"], "handshake": h_item, "ack": k_item}
    pairing_ctx = {**context, "pairings": [stored]}

    def check(**params):
        p_ = {"contact": other_agent, "pairingDigest": pairing_digest}
        p_.update(params)
        return op_body("contact.check", p_)

    b_ = check()
    cases.append(
        v.case(
            "sign-contact-check",
            f"{SPEC} SignedOwnerAction, contact.check (04 §3.6.1)",
            {"op": "sign", "body": b_, "secretKey": v.hx(owner), "auxRand": v.hx(aux)},
            {
                "jcs": jcs_lenient(b_).decode("utf-8"),
                "bodyHash": v.hx(body_hash(b_)),
                "signatureInput": v.hx(v.tagged_hash(TAG, body_hash(b_))),
                "sig": sign(b_, owner, aux),
            },
        )
    )

    def check_case(case_id, why, signed, ctx, accept):
        if reference_verify_contact_check(signed, ctx) != accept:
            v.fail(f"{case_id}: the reference verifier disagrees")
        cases.append(
            v.case(
                case_id,
                f"{SPEC} contact.check, 04 §3.6.1: {why}" + ("" if accept else "; rejected, nothing stored"),
                {"op": "verify", "signed": signed, "context": ctx},
                {"outcome": "accept" if accept else "reject"},
            )
        )

    expiring = check()
    check_case("verify-contact-check", "pairingDigest equals the digest recomputed from the stored H and K", signed_body(check()), pairing_ctx, True)
    check_case("verify-contact-check-at-expiry", "verified at now = expiresAt (expiry has no skew)", signed_body(expiring), {**pairing_ctx, "now": expiring["expiresAt"]}, True)
    tampered_k = {**stored, "ack": {"envelope": {**k_item["envelope"], "sig": k_item["envelope"]["sig"][:-1] + ("0" if k_item["envelope"]["sig"][-1] != "0" else "1")}, "cek": k_item["cek"]}}
    for case_id, why, signed, ctx in [
        ("verify-contact-check-reject-contact-uppercase", "`contact` in upper-case hex (04 §2.4.1)", signed_body(check(contact="0x" + other_agent[2:].upper())), pairing_ctx),
        ("verify-contact-check-reject-digest-mismatch", "pairingDigest is not the recomputed one (it is the role-swapped digest)", signed_body(check(pairingDigest=swapped)), pairing_ctx),
        ("verify-contact-check-reject-wrong-signer", "signed by another key than `owner`", {"body": check(), "sig": sign(check(), other, aux)}, pairing_ctx),
        ("verify-contact-check-reject-expired", "now = expiresAt + 1", signed_body(expiring), {**pairing_ctx, "now": expiring["expiresAt"] + 1}),
        ("verify-contact-check-reject-lifetime", "expiresAt - issuedAt = 86 401 s (L(contact.check) = 86 400 s, G-7)", signed_body(op_body("contact.check", {"contact": other_agent, "pairingDigest": pairing_digest}, expires_at=ISSUED_AT + 86401)), pairing_ctx),
        ("verify-contact-check-reject-unknown-contact", "`contact` is not a stored contact", signed_body(check(contact=third_agent)), pairing_ctx),
        ("verify-contact-check-reject-stored-ack-tampered", "the stored K no longer verifies, so no digest can be recomputed (never a stored digest)", signed_body(check()), {**context, "pairings": [tampered_k]}),
    ]:
        check_case(case_id, why, signed, ctx, False)
    for case_id, why, bad in [
        ("reject-pairing-digest-0x", "`pairingDigest` with 0x (bare hex, 04 §2.4.1)", check(pairingDigest="0x" + pairing_digest)),
        ("reject-pairing-digest-uppercase", "`pairingDigest` in upper-case hex", check(pairingDigest=pairing_digest.upper())),
        ("reject-pairing-digest-base64url", "`pairingDigest` as base64url", check(pairingDigest=v.b64u(bytes.fromhex(pairing_digest)))),
        ("reject-contact-checksummed", "`contact` in EIP-55 mixed case", check(contact=v.eip55(other_agent))),
        ("reject-contact-check-unknown-param", "unknown key in contact.check params", op_body("contact.check", {"contact": other_agent, "pairingDigest": pairing_digest, "note": "x"})),
    ]:
        if reference_verify_contact_check(signed_body(bad), pairing_ctx):
            v.fail(f"{case_id}: the reference verifier accepts it")
        reject(case_id, why, signed_body(bad), pairing_ctx)

    # contact.rename and contact.remove (M1-9za; 04 §2.5.1, proposed): {contact, alias}, {contact};
    # L(op) = 600 s; no envelope carrier. Their store rules are the core's (not vectors).
    rename = op_body("contact.rename", {"contact": other_agent, "alias": "Ana Kovač"})
    remove = op_body("contact.remove", {"contact": other_agent})
    for case_id, why, b in [
        ("sign-contact-rename", "contact.rename, an alias with a non-ASCII letter (M1-9za)", rename),
        ("sign-contact-remove", "contact.remove (M1-9za)", remove),
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
    for case_id, why, signed, ctx in [
        ("verify-contact-rename", "contact.rename verifies (M1-9za)", signed_body(rename), context),
        ("verify-contact-remove", "contact.remove verifies (M1-9za)", signed_body(remove), context),
        ("verify-contact-remove-at-expiry", "contact.remove verified at now = expiresAt (expiry has no skew)", signed_body(remove), {**context, "now": remove["expiresAt"]}),
    ]:
        cases.append(v.case(case_id, f"{SPEC}: {why}", {"op": "verify", "signed": signed, "context": ctx}, {"outcome": "accept"}))
    for case_id, why, signed in [
        ("reject-contact-rename-lifetime", "expiresAt - issuedAt = 601 s (L(contact.rename) = 600 s)", signed_body(op_body("contact.rename", {"contact": other_agent, "alias": "Ana"}, expires_at=ISSUED_AT + 601))),
        ("reject-contact-remove-lifetime", "expiresAt - issuedAt = 601 s (L(contact.remove) = 600 s)", signed_body(op_body("contact.remove", {"contact": other_agent}, expires_at=ISSUED_AT + 601))),
        ("reject-contact-rename-contact-uppercase", "`contact` in upper-case hex (04 §2.4.1)", signed_body(op_body("contact.rename", {"contact": "0x" + other_agent[2:].upper(), "alias": "Ana"}))),
        ("reject-contact-remove-contact-checksummed", "`contact` in EIP-55 mixed case", signed_body(op_body("contact.remove", {"contact": v.eip55(other_agent)}))),
        ("reject-contact-rename-alias-empty", "an empty alias", signed_body(op_body("contact.rename", {"contact": other_agent, "alias": ""}))),
        ("reject-contact-rename-alias-33", "an alias of 33 code points (at most 32)", signed_body(op_body("contact.rename", {"contact": other_agent, "alias": "č" * 33}))),
        ("reject-contact-rename-unknown-param", "unknown key in contact.rename params", signed_body(op_body("contact.rename", {"contact": other_agent, "alias": "Ana", "note": "x"}))),
        ("reject-contact-remove-alias", "contact.remove carrying an `alias` (strict params)", signed_body(op_body("contact.remove", {"contact": other_agent, "alias": "Ana"}))),
        ("reject-contact-rename-other-signer", "signed by another key than `owner`", {"body": rename, "sig": sign(rename, other, aux)}),
    ]:
        reject(case_id, why, signed)

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


def keyed_party(name, labels, relays):
    """A card from explicit key labels (so the agent under test has the context's own keys), with
    the owner's cardSig and the agent's cardAgentSig, in the shape generate_pairing_bodies uses."""
    sk = {field: v.det(label, 32) for field, label in labels.items()}
    name_hash, relays_hash = eip712.card_hashes(name, relays)
    card = {
        "version": 1,
        "agentEvm": v.evm_address(sk["agentEvm"]),
        "agentNostr": eip712.b32(v.xonly_public_key(sk["agentNostr"])),
        "agentEnc": eip712.b32(v.x25519_public_key(sk["agentEnc"])),
        "ownerEvm": v.evm_address(sk["ownerEvm"]),
        "ownerNostr": eip712.b32(v.xonly_public_key(sk["ownerNostr"])),
        "ownerEnc": eip712.b32(v.x25519_public_key(sk["ownerEnc"])),
        "nameHash": name_hash,
        "relaysHash": relays_hash,
        "issuedAt": 1760000000,
        "expiresAt": 1791536000,
        "keyEpoch": 0,
    }
    digest = eip712.card_digest(card)
    return {
        "card": card,
        "name": name,
        "relays": list(relays),
        "cardSig": eip712.card_sig(sk["ownerEvm"], digest),
        "cardAgentSig": eip712.card_sig(sk["agentEvm"], digest),
        "nostr": sk["agentNostr"],
        "enc": [sk["agentEnc"], sk["ownerEnc"]],
    }


SKEW = 300
L_CONTACT_CHECK = 86400


def reference_verify_contact_check(signed, ctx):
    """04 §2.5.1 verification of a contact.check, in order, then 04 §3.6.1: the digest must equal
    the one recomputed from the stored H and K of a completed pairing with that contact."""
    import re

    if not isinstance(signed, dict) or set(signed) != {"body", "sig"}:
        return False
    body, sig = signed["body"], signed["sig"]
    if not isinstance(body, dict) or set(body) != {"v", "agent", "owner", "op", "params", "nonce", "issuedAt", "expiresAt"}:
        return False
    if body["v"] != 1 or body["op"] != "contact.check" or not isinstance(sig, str) or not re.fullmatch(r"[0-9a-f]{128}", sig):
        return False
    if not isinstance(body["agent"], str) or not re.fullmatch(r"0x[0-9a-f]{40}", body["agent"]):
        return False
    if not isinstance(body["owner"], str) or not re.fullmatch(r"[0-9a-f]{64}", body["owner"]):
        return False
    try:
        if len(v.unb64u(body["nonce"])) != 16:
            return False
    except (ValueError, TypeError):
        return False
    for key in ("issuedAt", "expiresAt"):
        if isinstance(body[key], bool) or not isinstance(body[key], int) or not 0 <= body[key] <= 2**53 - 1:
            return False
    params = body["params"]
    if not isinstance(params, dict) or set(params) != {"contact", "pairingDigest"}:
        return False
    if not isinstance(params["contact"], str) or not re.fullmatch(r"0x[0-9a-f]{40}", params["contact"]):
        return False
    if not isinstance(params["pairingDigest"], str) or not re.fullmatch(r"[0-9a-f]{64}", params["pairingDigest"]):
        return False
    if body["agent"] != ctx["agent"] or bytes.fromhex(body["owner"]) != bytes.fromhex(ctx["ownerNostr"][2:]):
        return False
    if not v.schnorr_verify(bytes.fromhex(body["owner"]), v.tagged_hash(TAG, body_hash(body)), bytes.fromhex(sig)):
        return False
    now = ctx["now"]
    if body["issuedAt"] > now + SKEW or now > body["expiresAt"] or body["issuedAt"] >= body["expiresAt"]:
        return False
    if body["expiresAt"] - body["issuedAt"] > L_CONTACT_CHECK:
        return False
    matches = [p for p in ctx.get("pairings", []) if p["contact"] == params["contact"]]
    if len(matches) != 1:
        return False
    stored = matches[0]
    try:
        digest, _ = safety.recompute(ctx["agent"], stored["contactCard"], stored["handshake"], stored["ack"])
    except (ValueError, KeyError, TypeError):
        return False
    return digest.hex() == params["pairingDigest"]


CONTEXT = {
    "type": "object",
    "additionalProperties": False,
    "required": ["agent", "ownerNostr", "now"],
    "properties": {
        "agent": v.ADDRESS,
        "ownerNostr": {"type": "string", "pattern": "^0x[0-9a-f]{64}$"},
        "now": v.INTEGER,
        "pendingApproval": v.strict_object({"approvalId": v.STRING, "actionDigest": v.hexn(32), "expiresAt": v.INTEGER}),
        "pendingApprovals": {
            "type": "array",
            "items": v.strict_object({"approvalId": v.STRING, "actionDigest": v.hexn(32), "expiresAt": v.INTEGER}),
        },
        "pairings": {
            "type": "array",
            "items": v.strict_object({"contact": v.ADDRESS, "contactCard": v.OBJECT, "handshake": safety.ITEM, "ack": safety.ITEM}),
        },
        "appliedPolicyVersion": v.INTEGER,
    },
}
SCHEMA = v.case_schema(
    SUITE,
    "04 §2.5.1 SignedOwnerAction. `sign`: JCS text, sha256 body hash, tagged signature input and "
    "sig for a body. `verify`: accept or reject a SignedOwnerAction for a receiving core whose "
    "agent address, card ownerNostr and clock are given in `context` (nonce store empty; "
    "`appliedPolicyVersion` absent means 0; `pendingApprovals` lists the pending requests an "
    "approval.decideBatch names; `pairings` lists the completed pairings as stored, each with its "
    "signed handshake and handshake-ack and their CEKs, from which contact.check's pairingDigest is "
    "recomputed).",
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
        libraries=["cryptography", "coincurve", "pycryptodome", "pyhpke", "rfc8785"],
        build=build,
        schema=SCHEMA,
        doc=__doc__,
    )
