#!/usr/bin/env bash
# OPS-CI-9: run a command with an unlocked throwaway gnome-keyring, started once the Secret Service
# is ready. Call it inside `dbus-run-session --`:
#   dbus-run-session -- tools/ci/with-keyring.sh <command> [args...]
# The keyring password is random per run and never printed (the runner is ephemeral).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

keyring_env="$(openssl rand -hex 16 | gnome-keyring-daemon --unlock --components=secrets)"
eval "$keyring_env"
export GNOME_KEYRING_CONTROL

"$here/wait-for-keyring.sh"

exec "$@"
