#!/usr/bin/env python3
"""Independent generator for the `desktop-update` suite: signed desktop update manifests, format v2 (UPD-1).

08 §8 "Signed updates" (D-145 (5), WP-D10) as changed by UPD-1 (owner decision 2026-11-13): one
update key, its public key pinned in the app; no root key and no key statements. A manifest is a
BIP-340 signature by that key over taggedHash("agentlink-desktop-update/v2", JCS(manifest without
`sig`)). v2 adds the asset field `kind` (dmg, zip, nsis); `channel` and `expires` stay.

Computed with CPython's hashlib (tagged hash), `rfc8785` (JCS) and `coincurve` (BIP-340), never with
the TypeScript code under test. Keys and aux randomness are derived from labelled test seeds
(vectorlib.det). Each case gives the signed document, the tag and a public key; the expected values
are the 32-byte message and whether the signature verifies under that key. The desktop app's tests
(apps/desktop/test/unit/update-vectors.test.ts) and the offline tool's tests read the same file and
check the app's verdict on each document (accepted, old_format, wrong_key, expired, ...).

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

MANIFEST_V2 = "agentlink-desktop-update/v2"
MANIFEST_V1 = "agentlink-desktop-update/v1"
SOURCE = "08 §8 Signed updates (D-145 (5)); UPD-1 format v2, one pinned update key"
RELEASES = "https://github.com/4thtech/agentlink/releases/download"


def key(label):
    secret = v.det(f"desktop-update/{label}", 32)
    return secret, v.xonly_public_key(secret)


PINNED_SK, PINNED_PK = key("pinned-update-key")
OTHER_SK, OTHER_PK = key("other-key")


def plus_days(text, days):
    moment = datetime.strptime(text, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    return (moment + timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")


def message(tag, doc):
    return v.tagged_hash(tag, v.jcs({k: val for k, val in doc.items() if k != "sig"}))


def signed(tag, body, secret, label):
    sig = v.schnorr_sign(secret, message(tag, body), v.det(f"desktop-update/aux/{label}", 32))
    return {**body, "sig": v.hx(sig)}


def asset(version, arch, kind):
    ext = {"dmg": "dmg", "zip": "zip"}[kind]
    data = f"test installer {version} {arch} {kind}".encode()
    return {
        "platform": "darwin",
        "arch": arch,
        "kind": kind,
        "url": f"{RELEASES}/v{version}/AgentLink-{version}-{arch}.{ext}",
        "sha256": v.hx(v.sha256(data)),
        "size": len(data),
    }


def manifest(label, *, version, channel="beta", released="2026-11-13T08:00:00Z", days=30,
             secret=PINNED_SK, public=PINNED_PK, domain=MANIFEST_V2):
    items = [asset(version, arch, kind) for arch in ["arm64", "x64"] for kind in ["zip", "dmg"]]
    if domain == MANIFEST_V1:  # the v1 asset shape: no kind, DMGs only
        items = [{k: a[k] for k in a if k != "kind"} for a in items if a["kind"] == "dmg"]
    body = {
        "domain": domain,
        "channel": channel,
        "version": version,
        "minimumVersion": "0.5.0",
        "released": released,
        "expires": plus_days(released, days),
        "updateKey": v.hx(public),
        "assets": items,
    }
    return signed(domain, body, secret, label)


def item(case_id, why, tag, document, signer):
    digest = message(tag, document)
    valid = v.schnorr_verify(signer, digest, bytes.fromhex(document["sig"]))
    return v.case(
        case_id,
        f"{SOURCE}; {why}",
        {"op": "desktopUpdateSignature", "tag": tag, "document": document, "signer": v.hx(signer)},
        {"message": v.hx(digest), "valid": "true" if valid else "false"},
    )


def build():
    ok = manifest("ok", version="0.5.3")
    stable = manifest("stable", version="0.5.3", channel="stable")
    expired = manifest("expired", version="0.5.3", released="2026-10-01T08:00:00Z", days=30)
    downgrade = manifest("downgrade", version="0.5.1")
    other = manifest("other-key", version="0.5.3", secret=OTHER_SK, public=OTHER_PK)
    claims_pinned = manifest("claims-pinned", version="0.5.3", secret=OTHER_SK, public=PINNED_PK)
    v1 = manifest("v1", version="0.5.3", domain=MANIFEST_V1)
    tampered = copy.deepcopy(ok)
    tampered["assets"][0]["sha256"] = "00" * 32

    return [
        item("manifest-beta-ok", "a beta manifest by the pinned key (zip and dmg per arch)",
             MANIFEST_V2, ok, PINNED_PK),
        item("manifest-stable-ok", "a stable manifest by the pinned key", MANIFEST_V2, stable,
             PINNED_PK),
        item("manifest-expired", "a manifest past its expiry", MANIFEST_V2, expired, PINNED_PK),
        item("manifest-downgrade", "a validly signed older version", MANIFEST_V2, downgrade,
             PINNED_PK),
        item("manifest-other-key", "signed by and naming a key that is not pinned", MANIFEST_V2,
             other, OTHER_PK),
        item("manifest-other-key-under-pinned", "the same document checked under the pinned key",
             MANIFEST_V2, other, PINNED_PK),
        item("manifest-claims-pinned-key", "names the pinned key but is signed by another",
             MANIFEST_V2, claims_pinned, PINNED_PK),
        item("manifest-v1", "a format v1 manifest under the v1 tag (refused for install)",
             MANIFEST_V1, v1, PINNED_PK),
        item("manifest-v2-under-v1-tag", "a v2 manifest checked under the v1 tag never verifies",
             MANIFEST_V1, ok, PINNED_PK),
        item("manifest-tampered", "an asset hash changed after signing", MANIFEST_V2, tampered,
             PINNED_PK),
    ]


SCHEMA = v.case_schema(
    SUITE,
    "A signed desktop update manifest (`document`) checked under `tag` against `signer` (x-only "
    "public key): the BIP-340 message taggedHash(tag, JCS(document without sig)) and whether `sig` "
    "verifies.",
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
