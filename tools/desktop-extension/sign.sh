#!/usr/bin/env bash
# M1-9f (D-91): signs Claude Desktop extension bundles (MCPB) in place.
#   sign.sh <key.pem> <certificate.pem> <bundle.mcpb>...
# Format (reference: @anthropic-ai/mcpb 2.1.2, dist/node/sign.js): a detached PKCS#7 / CMS
# SignedData over the zip bytes, SHA-256 digest, RSA signature, signer certificate included,
# authenticated attributes contentType, messageDigest and signingTime, appended as the MCPB
# signature block (tools/desktop-extension/signature.mjs). RSA because the reference signer reads
# keys with node-forge, which supports RSA keys only.
# Never prints the key. The caller owns the key file and removes it.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
key="$1"
cert="$2"
shift 2
[ "$#" -gt 0 ] || { echo "usage: sign.sh <key.pem> <cert.pem> <bundle>..." >&2; exit 2; }
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
for bundle in "$@"; do
  openssl cms -sign -binary -md sha256 -nosmimecap -outform DER \
    -signer "$cert" -inkey "$key" -in "$bundle" -out "$work/sig.der"
  node "$here/signature.mjs" append "$bundle" "$work/sig.der"
  rm -f "$work/sig.der"
done
