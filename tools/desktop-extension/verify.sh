#!/usr/bin/env bash
# M1-9f (D-91): checks that each bundle carries an MCPB signature block whose CMS signature
# verifies over the zip bytes against exactly the given (beta: self-signed) certificate.
#   verify.sh <certificate.pem> <bundle.mcpb>...
# Exits non-zero on the first bundle that is unsigned, altered, or signed by another key.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
cert="$1"
shift
[ "$#" -gt 0 ] || { echo "usage: verify.sh <cert.pem> <bundle>..." >&2; exit 2; }
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
for bundle in "$@"; do
  node "$here/signature.mjs" extract "$bundle" "$work/content" "$work/sig.der"
  # -nointern ignores certificates carried in the signature and -certfile/-CAfile pin trust to this
  # one certificate, so a bundle signed by any other key fails.
  if ! openssl cms -verify -binary -inform DER -in "$work/sig.der" -content "$work/content" \
    -nointern -certfile "$cert" -CAfile "$cert" -purpose any -out /dev/null 2> "$work/err"; then
    echo "Signature check failed for $(basename "$bundle")." >&2
    exit 1
  fi
  echo "Signature verified: $(basename "$bundle")"
done
