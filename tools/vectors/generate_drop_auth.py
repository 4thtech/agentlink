#!/usr/bin/env python3
"""Independent generator for the `drop-auth` suite: the encrypted drop's request signature and URL MAC (M1-27a).

07 §5.4, 04 §4 (D-48). A drop request carries `Authorization: Nostr <base64url(JSON event)>`, a
NIP-98-style event of kind 27235 signed with the drop key (BIP-340 over the NIP-01 event id), with empty
content and exactly the tags ["u", url], ["method", POST|DELETE], ["payload", hex sha256(body)] and
["domain", "agentlink/v1/drop"], in that order. The verifier checks the header form, then the binding to
method, URL and body, then |now - created_at| <= 60, then the id and signature.

URL MAC = HMAC-SHA256(key, utf8("agentlink/v1/drop-url") || 0x00 || purpose (0x01 put, 0x02 get) ||
objectId (16 bytes) || u16be(part) || u64be(expiresAt)). Computed here with CPython's hmac and coincurve
(BIP-340), independently of @agentlink/crypto. Keys, bodies and nonces are deterministic test bytes.

Usage: python3 -I tools/vectors/generate_drop_auth.py --check [FILE] | --write
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import vectorlib as v  # noqa: E402

SUITE = "drop-auth"
VERSION = 1
SPEC = "07 §5.4 drop request signature"
MAC_SPEC = "07 §5.4 drop URL MAC"
KIND = 27235
DOMAIN = "agentlink/v1/drop"
SKEW = 60
LABEL = b"agentlink/v1/drop-url"
NOW = 1790000000
URL = "https://drop.agentlink.4thtech.io/v1/upload"


def nostr_id(pubkey_hex, event):
    serialized = json.dumps(
        [0, pubkey_hex, event["created_at"], event["kind"], event["tags"], event["content"]],
        separators=(",", ":"),
        ensure_ascii=False,
    )
    return v.sha256(serialized.encode("utf-8"))


def sign(secret, event, aux_label):
    pubkey = v.xonly_public_key(secret).hex()
    event_id = nostr_id(pubkey, event)
    sig = v.schnorr_sign(secret, event_id, v.det(aux_label, 32))
    return {
        "id": event_id.hex(),
        "pubkey": pubkey,
        "created_at": event["created_at"],
        "kind": event["kind"],
        "tags": event["tags"],
        "content": event["content"],
        "sig": sig.hex(),
    }


def header(signed):
    return "Nostr " + v.b64u(json.dumps(signed, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))


def auth_event(method, url, body, created_at):
    return {
        "kind": KIND,
        "created_at": created_at,
        "tags": [["u", url], ["method", method], ["payload", v.sha256(body).hex()], ["domain", DOMAIN]],
        "content": "",
    }


def url_mac(key, purpose, object_id, part, expires_at):
    message = (
        LABEL
        + b"\x00"
        + (b"\x01" if purpose == "put" else b"\x02")
        + object_id
        + v.u16be(part)
        + int(expires_at).to_bytes(8, "big")
    )
    return v.hmac_sha256(key, message)


def build():
    cases = []
    key = v.det("drop-auth/url-key", 32)
    object_id = v.det("drop-auth/object-id", 16)
    for case_id, purpose, part, expires_at in [
        ("url-mac-get", "get", 0, 1790604800),
        ("url-mac-put-single", "put", 0, 1790000900),
        ("url-mac-put-part-3", "put", 3, 1790000900),
        ("url-mac-put-part-max", "put", 10000, 1790000900),
        ("url-mac-expiry-above-2-32", "get", 0, 2**32 + 5),
    ]:
        cases.append(
            v.case(
                case_id,
                f"{MAC_SPEC}: {purpose} part {part}",
                {
                    "op": "urlMac",
                    "key": key.hex(),
                    "purpose": purpose,
                    "objectId": object_id.hex(),
                    "part": str(part),
                    "expiresAt": str(expires_at),
                },
                {"mac": url_mac(key, purpose, object_id, part, expires_at).hex()},
            )
        )

    secret = v.det("drop-auth/drop-key", 32)
    pubkey = v.xonly_public_key(secret).hex()
    body = json.dumps(
        {"v": 1, "size": 20000, "expiresAt": NOW + 86400, "nonce": v.b64u(v.det("drop-auth/nonce", 16)), "ts": NOW},
        separators=(",", ":"),
    ).encode("utf-8")
    event = auth_event("POST", URL, body, NOW)
    cases.append(
        v.case(
            "event-upload",
            f"{SPEC}: the unsigned event and its NIP-01 id for an upload request",
            {"op": "authEvent", "method": "POST", "url": URL, "body": body.hex(), "createdAt": str(NOW), "pubkey": pubkey},
            {"payload": v.sha256(body).hex(), "eventId": nostr_id(pubkey, event).hex()},
        )
    )

    def verify_case(case_id, why, auth, expected, method="POST", url=URL, body_=body, now=NOW):
        cases.append(
            v.case(
                case_id,
                f"{SPEC}: {why}",
                {"op": "verify", "authorization": auth, "method": method, "url": url, "body": body_.hex(), "now": str(now)},
                expected,
            )
        )

    good = sign(secret, event, "drop-auth/aux-good")
    accept = {"outcome": "accept", "pubkey": pubkey}
    verify_case("verify-accept", "a correctly signed upload request", header(good), accept)
    verify_case("verify-accept-skew-edge", "created_at exactly 60 s before now", header(good), accept, now=NOW + SKEW)

    delete_url = "https://drop.agentlink.4thtech.io/v1/o/" + v.b64u(object_id)
    delete_body = json.dumps({"v": 1, "objectId": v.b64u(object_id), "nonce": v.b64u(v.det("drop-auth/nonce-2", 16)), "ts": NOW}, separators=(",", ":")).encode()
    signed_delete = sign(secret, auth_event("DELETE", delete_url, delete_body, NOW), "drop-auth/aux-delete")
    verify_case("verify-accept-delete", "a signed DELETE", header(signed_delete), accept, method="DELETE", url=delete_url, body_=delete_body)

    def reject(reason):
        return {"outcome": "reject", "reason": reason}

    verify_case("verify-reject-stale", "created_at 61 s before now", header(good), reject("stale"), now=NOW + SKEW + 1)
    verify_case("verify-reject-future", "created_at 61 s after now", header(good), reject("stale"), now=NOW - SKEW - 1)
    verify_case("verify-reject-other-url", "signed for another URL", header(good), reject("request_mismatch"), url=URL + "?x=1")
    verify_case("verify-reject-other-host", "signed for another host", header(good), reject("request_mismatch"), url="https://evil.example/v1/upload")
    verify_case("verify-reject-other-method", "signed for POST, sent as DELETE", header(good), reject("request_mismatch"), method="DELETE")
    verify_case("verify-reject-other-body", "signed over another body", header(good), reject("request_mismatch"), body_=body + b" ")

    tampered = dict(good)
    tampered["sig"] = good["sig"][:-2] + ("00" if not good["sig"].endswith("00") else "01")
    verify_case("verify-reject-signature", "a changed signature", header(tampered), reject("invalid_signature"))
    wrong_id = dict(good)
    wrong_id["id"] = v.sha256(b"not the event").hex()
    verify_case("verify-reject-id", "an id that is not the event's NIP-01 id", header(wrong_id), reject("invalid_signature"))
    other_key = sign(v.det("drop-auth/other-key", 32), event, "drop-auth/aux-other")
    swapped = dict(good)
    swapped["pubkey"] = other_key["pubkey"]
    verify_case("verify-reject-pubkey-swap", "another key's pubkey on this signature", header(swapped), reject("invalid_signature"))

    relay_auth = dict(event)
    relay_auth["kind"] = 22242
    verify_case("verify-reject-kind", "kind 22242 (relay AUTH) instead of 27235", header(sign(secret, relay_auth, "drop-auth/aux-kind")), reject("malformed"))
    other_domain = dict(event)
    other_domain["tags"] = event["tags"][:3] + [["domain", "agentlink/v1/other"]]
    verify_case("verify-reject-domain", "another domain tag", header(sign(secret, other_domain, "drop-auth/aux-domain")), reject("malformed"))
    no_domain = dict(event)
    no_domain["tags"] = event["tags"][:3]
    verify_case("verify-reject-no-domain", "no domain tag (plain NIP-98)", header(sign(secret, no_domain, "drop-auth/aux-nodomain")), reject("malformed"))
    content = dict(event)
    content["content"] = "x"
    verify_case("verify-reject-content", "non-empty content", header(sign(secret, content, "drop-auth/aux-content")), reject("malformed"))
    extra = dict(good)
    extra["extra"] = "1"
    verify_case("verify-reject-extra-key", "an extra event property", header(extra), reject("malformed"))
    verify_case("verify-reject-scheme", "another Authorization scheme", "Bearer " + header(good)[len("Nostr "):], reject("malformed"))
    verify_case("verify-reject-padded", "base64url with padding", header(good) + "=", reject("malformed"))
    return cases


ACCEPT_PUBKEY = {"outcome": {"const": "accept"}, "pubkey": v.hexn(32)}
REJECT_REASON = {"outcome": {"const": "reject"}, "reason": {"enum": ["malformed", "request_mismatch", "stale", "invalid_signature"]}}
DECIMAL = {"type": "string", "pattern": "^(0|[1-9][0-9]*)$"}

SCHEMA = v.case_schema(
    SUITE,
    "07 §5.4 encrypted drop. `urlMac`: the URL MAC. `authEvent`: the body hash and NIP-01 id of the "
    "unsigned kind-27235 event for a request and a drop key. `verify`: accept (with the drop key) or "
    "reject (with the reason).",
    {
        "urlMac": (
            {"key": v.hexn(32), "purpose": {"enum": ["put", "get"]}, "objectId": v.hexn(16), "part": DECIMAL, "expiresAt": DECIMAL},
            [{"mac": v.hexn(32)}],
        ),
        "authEvent": (
            {"method": v.STRING, "url": v.STRING, "body": v.HEX, "createdAt": DECIMAL, "pubkey": v.hexn(32)},
            [{"payload": v.hexn(32), "eventId": v.hexn(32)}],
        ),
        "verify": (
            {"authorization": v.STRING, "method": v.STRING, "url": v.STRING, "body": v.HEX, "now": DECIMAL},
            [ACCEPT_PUBKEY, REJECT_REASON],
        ),
    },
)

if __name__ == "__main__":
    v.main(
        suite=SUITE,
        version=VERSION,
        script="tools/vectors/generate_drop_auth.py",
        libraries=["coincurve"],
        build=build,
        schema=SCHEMA,
        doc=__doc__,
    )
