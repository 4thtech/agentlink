#!/usr/bin/env python3
"""Independent generator for the `owner-action` suite: SignedOwnerAction (M1-1h, D-58).

04 §2.5.1, exactly:
  sig = BIP-340 by `owner` over taggedHash("agentlink/owner-action/v1", sha256(JCS(OwnerAction)))
JCS is Trail of Bits' `rfc8785`, BIP-340 is libsecp256k1 (coincurve). Keys, nonces and aux_rand
are synthetic test values.

Only `agent.revoke` is used: its `params` ({reason}) and its expiry rule (expiresAt = 0) are fully
fixed by 04 §2.5.1. `approval.decide` waits for the encoding of `actionDigest` and `policy.set`
for the 06 §3 policy schema (M1-2b); see the M1-1h PR.

`verify` cases give the receiving core's context: the agent's own EVM address, `ownerNostr` from
its card, the current time and an empty nonce store. Every rejection vector for a non-canonical
form carries a signature that is VALID over the JCS of that non-canonical body, so it can only be
refused by the encoding check (04 §2.5.1: "rejected, never normalised"). The forms are those the
card lists: checksummed or uppercase address, uppercase hex, padded base64url, out-of-range
integer, unknown key; plus a missing key, wrong types and wrong lengths. The other refusals: wrong
agent, wrong owner, another signer, the envelope tag, no tag, a body changed after signing, an
unknown op, a bad reason and expiresAt != 0 for agent.revoke.

Usage: python3 -I tools/vectors/generate_owner_action.py --check [FILE] | --write
"""

import copy
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
    context = {"agent": agent, "ownerNostr": owner_pub, "now": ISSUED_AT + 60}

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
    reject("reject-owner-0x-prefix", "`owner` with a 0x prefix", signed_body(body(owner="0x" + owner_pub)))
    reject("reject-sig-uppercase-hex", "`sig` hex digits in upper case (the signature is otherwise valid)", {"body": good, "sig": good_sig.upper()})
    reject("reject-sig-short", "`sig` of 127 hex digits", {"body": good, "sig": good_sig[:-1]})
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
    return cases


CONTEXT = {
    "type": "object",
    "additionalProperties": False,
    "required": ["agent", "ownerNostr", "now"],
    "properties": {"agent": v.ADDRESS, "ownerNostr": v.hexn(32), "now": v.INTEGER},
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
