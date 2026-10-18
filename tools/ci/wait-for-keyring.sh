#!/usr/bin/env bash
# OPS-CI-9: wait until the Secret Service answers a store/lookup round trip, so a test that opens an
# agent never races a keyring that is still starting. Needs `secret-tool` (libsecret-tools) and a
# D-Bus session with an unlocked keyring. Only a throwaway item is written (random value, cleared
# afterwards, never printed). Tunables: KEYRING_WAIT_ATTEMPTS (default 10), KEYRING_WAIT_INTERVAL
# seconds (default 1).
set -uo pipefail

attempts="${KEYRING_WAIT_ATTEMPTS:-10}"
interval="${KEYRING_WAIT_INTERVAL:-1}"
tag="agentlink-ci-keyring-probe-$$"

i=1
while [ "$i" -le "$attempts" ]; do
  value="$(openssl rand -hex 8)"
  if printf '%s' "$value" | secret-tool store --label="$tag" agentlink-ci-probe "$tag" >/dev/null 2>&1 \
    && [ "$(secret-tool lookup agentlink-ci-probe "$tag" 2>/dev/null)" = "$value" ]; then
    secret-tool clear agentlink-ci-probe "$tag" >/dev/null 2>&1 || true
    echo "Secret Service ready after $i attempt(s)."
    exit 0
  fi
  [ "$i" -lt "$attempts" ] && sleep "$interval"
  i=$((i + 1))
done

echo "::error::The Linux Secret Service (gnome-keyring) did not answer a store/lookup round trip after $attempts attempt(s)."
exit 1
