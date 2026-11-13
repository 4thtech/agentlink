#!/usr/bin/env python3
"""Independent generator for the `desktop-update` suite: signed desktop update documents, format v2 (UPD-1).

08 §8 "Signed updates" (D-145 (5), WP-D10) and the v2 format of UPD-1: a key statement is a BIP-340
signature by the offline ROOT key over taggedHash("agentlink-desktop-root/v2", JCS(statement without
`sig`)); a manifest is a BIP-340 signature by the UPDATE key the embedded statement names, over
taggedHash("agentlink-desktop-update/v2", JCS(manifest without `sig`)). v2 adds the statement fields
`channel` and `expires`, the action `renew`, and the asset field `kind` (dmg, zip, nsis).

Computed with CPython's hashlib (tagged hash), `rfc8785` (JCS) and `coincurve` (BIP-340), never with
the TypeScript code under test. Keys and aux randomness are derived from labelled test seeds
(vectorlib.det). Each case gives the signed document, the tag and the signer's public key; the
expected values are the 32-byte message and whether the signature verifies. The desktop app's own
tests (apps/desktop/test/unit/update-vectors.test.ts) and the offline tool's tests read the same file
and check the app's verdict for each document (accepted, old_format, statement_expired, ...).

Usage: python3 -I tools/vectors/generate_desktop_update.py --check [FILE] | --write
"""

import copy
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import vectorlib as v  # noqa: E402

SUITE = "desktop-update"
VERSION = 1

STATEMENT_V2 = "agentlink-desktop-root/v2"
MANIFEST_V2 = "agentlink-desktop-update/v2"
STATEMENT_V1 = "agentlink-desktop-root/v1"
MANIFEST_V1 = "agentlink-desktop-update/v1"
SOURCE = "08 §8 Signed updates (D-145 (5)); UPD-1 format v2"
RELEASES = "https://github.com/4thtech/agentlink/releases/download"


def key(label):
    secret = v.det(f"desktop-update/{label}", 32)
    return secret, v.xonly_public_key(secret)


ROOT_SK, ROOT_PK = key("root")
BETA_SK, BETA_PK = key("beta-update-key")
STABLE_SK, STABLE_PK = key("stable-update-key")


def ts(text):
    return datetime.strptime(text, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def iso(moment):
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


def plus_days(text, days):
    return iso(ts(text) + timedelta(days=days))


def without_sig(doc):
    return {k: val for k, val in doc.items() if k != "sig"}


def message(tag, doc):
    return v.tagged_hash(tag, v.jcs(without_sig(doc)))


def signed(tag, body, secret, label):
    sig = v.schnorr_sign(secret, message(tag, body), v.det(f"desktop-update/aux/{label}", 32))
    return {**body, "sig": v.hx(sig)}


def statement(label, *, sequence, action, channel, update_key, issued, days, domain=STATEMENT_V2):
    body = {
        "domain": domain,
        "sequence": sequence,
        "action": action,
        "channel": channel,
        "updateKey": v.hx(update_key),
        "issued": issued,
        "expires": plus_days(issued, days),
    }
    if domain == STATEMENT_V1:  # the v1 shape: no channel, no expires
        body = {k: body[k] for k in ["domain", "sequence", "action", "updateKey", "issued"]}
    return signed(domain, body, ROOT_SK, label)


def asset(version, arch, kind, data):
    name = {
        "dmg": f"AgentLink-{version}-{arch}.dmg",
        "zip": f"AgentLink-{version}-{arch}.zip",
    }[kind]
    return {
        "platform": "darwin",
        "arch": arch,
        "kind": kind,
        "url": f"{RELEASES}/v{version}/{name}",
        "sha256": v.hx(v.sha256(data)),
        "size": len(data),
    }


def assets(version):
    out = []
    for arch in ["arm64", "x64"]:
        for kind in ["zip", "dmg"]:
            out.append(asset(version, arch, kind, f"test installer {version} {arch} {kind}".encode()))
    return out


def manifest(label, *, version, channel, stmt, secret, update_key, released, days=30,
             domain=MANIFEST_V2):
    items = assets(version)
    if domain == MANIFEST_V1:  # the v1 shape: no asset kind, DMGs only
        items = [{k: a[k] for k in a if k != "kind"} for a in items if a["kind"] == "dmg"]
    body = {
        "domain": domain,
        "channel": channel,
        "version": version,
        "minimumVersion": "0.5.0",
        "released": released,
        "expires": plus_days(released, days),
        "updateKey": v.hx(update_key),
        "statement": stmt,
        "assets": items,
    }
    return signed(domain, body, secret, label)


def item(case_id, why, tag, document, signer):
    sig = bytes.fromhex(document["sig"])
    digest = message(tag, document)
    valid = v.schnorr_verify(signer, digest, sig)
    return v.case(
        case_id,
        f"{SOURCE}; {why}",
        {
            "op": "desktopUpdateSignature",
            "tag": tag,
            "document": document,
            "signer": v.hx(signer),
        },
        {"message": v.hx(digest), "valid": "true" if valid else "false"},
    )


def build():
    s_beta = statement("s1", sequence=1, action="introduce", channel="beta", update_key=BETA_PK,
                       issued="2026-11-01T09:00:00Z", days=90)
    s_renew = statement("s2", sequence=2, action="renew", channel="beta", update_key=BETA_PK,
                        issued="2026-11-10T09:00:00Z", days=90)
    s_stable = statement("s3", sequence=3, action="introduce", channel="stable",
                         update_key=STABLE_PK, issued="2026-11-10T09:30:00Z", days=395)
    s_revoke = statement("s4", sequence=4, action="revoke", channel="beta", update_key=BETA_PK,
                         issued="2026-11-12T09:00:00Z", days=90)
    s_old = statement("s5", sequence=5, action="renew", channel="beta", update_key=BETA_PK,
                      issued="2026-01-01T09:00:00Z", days=90)
    s_v1 = statement("s1v1", sequence=1, action="introduce", channel="beta", update_key=BETA_PK,
                     issued="2026-11-01T09:00:00Z", days=90, domain=STATEMENT_V1)

    released = "2026-11-13T08:00:00Z"
    m_ok = manifest("m-ok", version="0.5.3", channel="beta", stmt=s_beta, secret=BETA_SK,
                    update_key=BETA_PK, released=released)
    m_renewed = manifest("m-renewed", version="0.5.3", channel="beta", stmt=s_renew,
                         secret=BETA_SK, update_key=BETA_PK, released=released)
    m_expired_statement = manifest("m-expired-statement", version="0.5.3", channel="beta",
                                   stmt=s_old, secret=BETA_SK, update_key=BETA_PK,
                                   released=released)
    m_stable_by_beta = manifest("m-stable-by-beta", version="0.5.3", channel="stable",
                                stmt=s_beta, secret=BETA_SK, update_key=BETA_PK,
                                released=released)
    m_stable_ok = manifest("m-stable-ok", version="0.5.3", channel="stable", stmt=s_stable,
                           secret=STABLE_SK, update_key=STABLE_PK, released=released)
    m_downgrade = manifest("m-downgrade", version="0.5.1", channel="beta", stmt=s_beta,
                           secret=BETA_SK, update_key=BETA_PK, released=released)
    m_v1 = manifest("m-v1", version="0.5.3", channel="beta", stmt=s_v1, secret=BETA_SK,
                    update_key=BETA_PK, released=released, domain=MANIFEST_V1)
    m_tampered = copy.deepcopy(m_ok)
    m_tampered["assets"][0]["sha256"] = "00" * 32

    return [
        item("statement-introduce-beta", "root introduces the beta key for 90 days",
             STATEMENT_V2, s_beta, ROOT_PK),
        item("statement-renew-beta", "renew: same key, higher sequence, later expiry",
             STATEMENT_V2, s_renew, ROOT_PK),
        item("statement-introduce-stable", "root introduces the stable key for 395 days",
             STATEMENT_V2, s_stable, ROOT_PK),
        item("statement-revoke-beta", "root withdraws the beta key", STATEMENT_V2, s_revoke,
             ROOT_PK),
        item("statement-expired-beta", "a beta statement whose expiry has passed",
             STATEMENT_V2, s_old, ROOT_PK),
        item("statement-v2-under-v1-tag", "a v2 statement checked under the v1 tag never verifies",
             STATEMENT_V1, s_beta, ROOT_PK),
        item("statement-under-update-key", "a statement checked against the update key never verifies",
             STATEMENT_V2, s_beta, BETA_PK),
        item("manifest-beta-ok", "a beta manifest by the beta key (zip and dmg per arch)",
             MANIFEST_V2, m_ok, BETA_PK),
        item("manifest-beta-renewed", "a beta manifest carrying the renew statement",
             MANIFEST_V2, m_renewed, BETA_PK),
        item("manifest-statement-expired", "a beta manifest whose statement has expired",
             MANIFEST_V2, m_expired_statement, BETA_PK),
        item("manifest-stable-by-beta-key", "a stable manifest under a beta-only statement",
             MANIFEST_V2, m_stable_by_beta, BETA_PK),
        item("manifest-stable-ok", "a stable manifest by the stable key", MANIFEST_V2,
             m_stable_ok, STABLE_PK),
        item("manifest-downgrade", "a validly signed older version", MANIFEST_V2, m_downgrade,
             BETA_PK),
        item("manifest-v1", "a format v1 manifest under the v1 tags (refused for install)",
             MANIFEST_V1, m_v1, BETA_PK),
        item("manifest-v2-under-v1-tag", "a v2 manifest checked under the v1 tag never verifies",
             MANIFEST_V1, m_ok, BETA_PK),
        item("manifest-tampered", "an asset hash changed after signing", MANIFEST_V2, m_tampered,
             BETA_PK),
    ]


SCHEMA = v.case_schema(
    SUITE,
    "A signed desktop update document (key statement or manifest, `document`) checked under `tag` "
    "against `signer` (x-only public key): the BIP-340 message taggedHash(tag, JCS(document "
    "without sig)) and whether `sig` verifies.",
    {
        "desktopUpdateSignature": (
            {"tag": v.STRING, "document": v.OBJECT, "signer": v.hexn(32)},
            [{"message": v.hexn(32), "valid": {"enum": ["true", "false"]}}],
        )
    },
)

if __name__ == "__main__":
    v.main(
        suite=SUITE,
        version=VERSION,
        script="tools/vectors/generate_desktop_update.py",
        libraries=["coincurve", "rfc8785"],
        build=build,
        schema=SCHEMA,
        doc=__doc__,
    )
