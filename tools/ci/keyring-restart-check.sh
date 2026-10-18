#!/usr/bin/env bash
# OPS-CI-10: the regression check for with-keyring.sh. Run it as
#   dbus-run-session -- tools/ci/with-keyring.sh tools/ci/keyring-restart-check.sh
# It stores a throwaway item, kills the Secret Service daemon with SIGKILL (as the e2e runs saw it
# die), then expects the item back and a new item stored, with no prompt, from the daemon D-Bus
# starts in its place. Before OPS-CI-10 the new daemon asked SystemPrompter and every call failed.
# with-keyring.sh prints a ::warning:: about the killed daemon; here that is expected.
set -euo pipefail

owner_pid() {
  dbus-send --session --print-reply --dest=org.freedesktop.DBus /org/freedesktop/DBus \
    org.freedesktop.DBus.GetConnectionUnixProcessID string:org.freedesktop.secrets |
    awk '/uint32/ { print $2 }'
}

tag="agentlink-ci-restart-check-$$"
value="$(openssl rand -hex 8)"
printf '%s' "$value" | secret-tool store --label="$tag" agentlink-ci-restart "$tag"

first="$(owner_pid)"
kill -KILL "$first"
for _ in $(seq 1 50); do
  kill -0 "$first" 2>/dev/null || break
  sleep 0.1
done

fail() {
  echo "::error::$1"
  exit 1
}

got="$(timeout 20 secret-tool lookup agentlink-ci-restart "$tag")" ||
  fail "After the Secret Service daemon was killed, the item could not be read back."
[ "$got" = "$value" ] || fail "After the Secret Service daemon was killed, the item read back wrong."
second="$(owner_pid)"
if [ -z "$second" ] || [ "$second" = "$first" ]; then fail "No new Secret Service daemon took over."; fi
printf '%s' "$value" | timeout 20 secret-tool store --label="$tag" agentlink-ci-restart "$tag-2" ||
  fail "After the Secret Service daemon was killed, a new item could not be stored."
secret-tool clear agentlink-ci-restart "$tag" || true
secret-tool clear agentlink-ci-restart "$tag-2" || true
echo "The keyring survived a killed daemon: the replacement served it with no prompt."
