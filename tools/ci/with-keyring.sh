#!/usr/bin/env bash
# OPS-CI-9, OPS-CI-10: run a command with a throwaway gnome-keyring that never needs a prompt.
# Call it inside `dbus-run-session --`:
#   dbus-run-session -- tools/ci/with-keyring.sh <command> [args...]
#
# Why it is set up this way (OPS-CI-10, the intermittent e2e "keychain refused" failure): the daemon
# started for the run sometimes ended mid-run without cleaning up (its control socket was left
# behind: "Connection refused"). The next Secret Service call made D-Bus start a fresh
# `gnome-keyring-daemon --start`, which found the login keyring locked with a random password nobody
# could give it, asked GNOME's SystemPrompter (which cannot run headless), and every keychain call
# failed from then on.
#
# So:
# - the login keyring is created up front as the default collection, with no password (gnome-
#   keyring's plain format, never locked), in a private data folder. Any daemon serving this D-Bus
#   session, the first one or one D-Bus starts later, opens it without a prompt and sees every item
#   written so far;
# - the daemon runs in its own session (a signal to the job's process group does not reach it), with
#   a private control folder, and its output is kept;
# - if it ends before the command does, a ::warning:: says how (exit status or signal) and shows the
#   end of its output, so the cause stays visible.
#
# CHORE-CI-HARDEN-1: the daemon is also supervised. A watchdog starts it again within 0.2 s of its
# end, on the same folders (unless D-Bus already started a replacement), and counts the restarts. A
# health probe (wait-for-keyring.sh) runs before the command. If the command fails after the
# daemon ended, the failure is reported as "runner keychain unavailable", so a keyring problem is
# never mistaken for a product bug and a test never passes because the keyring was missing.
#
# The keyring holds throwaway test data on an ephemeral runner; its folder is removed at the end.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]; then
  echo "::error::with-keyring.sh needs a D-Bus session: run it as 'dbus-run-session -- $0 <command>'."
  exit 1
fi

root="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/agentlink-keyring.XXXXXX")"
data="$root/data"
control="$root/control"
log="$root/daemon.log"
mkdir -m 700 "$data" "$data/keyrings" "$control"

cat >"$data/keyrings/login.keyring" <<'KEYRING'
[keyring]
display-name=login
ctime=0
mtime=0
lock-on-idle=false
lock-after=false
KEYRING
printf 'login' >"$data/keyrings/default"
chmod 600 "$data/keyrings/login.keyring" "$data/keyrings/default"

# A daemon that D-Bus starts later uses the same keyring folder.
dbus-update-activation-environment XDG_DATA_HOME="$data" GNOME_KEYRING_CONTROL="$control"

restarts="$root/restarts"
: >"$restarts"

# `env -u G_DEBUG`: the daemon must not turn a GLib critical warning into a trap (signal 5).
start_daemon() {
  XDG_DATA_HOME="$data" setsid env -u G_DEBUG gnome-keyring-daemon --foreground --components=secrets \
    --control-directory="$control" </dev/null >>"$log" 2>&1 &
  daemon_pid=$!
}
start_daemon

name_owned() {
  dbus-send --session --print-reply --dest=org.freedesktop.DBus /org/freedesktop/DBus \
    org.freedesktop.DBus.NameHasOwner string:org.freedesktop.secrets 2>/dev/null | grep -q 'boolean true'
}

# Watchdog: when the daemon we started ends and nobody owns the Secret Service name, start it again.
watchdog_pid=""
watchdog() {
  local pid="$1"
  while :; do
    if ! kill -0 "$pid" 2>/dev/null; then
      sleep 0.2
      if ! name_owned; then
        echo restart >>"$restarts"
        XDG_DATA_HOME="$data" setsid env -u G_DEBUG gnome-keyring-daemon --foreground --components=secrets \
          --control-directory="$control" </dev/null >>"$log" 2>&1 &
        pid=$!
      else
        # D-Bus started a replacement first; nothing to supervise from here.
        return 0
      fi
    fi
    sleep 0.2
  done
}

# shellcheck disable=SC2317 # called by the EXIT trap
cleanup() {
  [ -n "$watchdog_pid" ] && kill "$watchdog_pid" 2>/dev/null || true
  kill "$daemon_pid" 2>/dev/null || true
  pkill -u "$(id -u)" -f "gnome-keyring-daemon --foreground --components=secrets --control-directory=$control" 2>/dev/null || true
  rm -rf "$root"
}
trap cleanup EXIT

export GNOME_KEYRING_CONTROL="$control"

# Wait until this daemon owns the Secret Service name. Calling it earlier would make D-Bus start a
# second daemon on the same keyring folder. NameHasOwner never starts a service itself.
owned=false
for _ in $(seq 1 100); do
  kill -0 "$daemon_pid" 2>/dev/null || break
  if name_owned; then
    owned=true
    break
  fi
  sleep 0.1
done
if [ "$owned" != true ]; then
  echo "::error::gnome-keyring-daemon did not take the Secret Service name. Its output:"
  tail -n 20 "$log" || true
  exit 1
fi

# Health check before the command: a failing probe stops the job with a clear message.
if ! "$here/wait-for-keyring.sh"; then
  echo "::error::runner keychain unavailable: the Secret Service did not pass its health probe before the command started."
  exit 1
fi

watchdog "$daemon_pid" &
watchdog_pid=$!

status=0
"$@" || status=$?

restart_count="$(wc -l <"$restarts" | tr -d ' ')"
if [ "$status" -ne 0 ] && { [ "$restart_count" -gt 0 ] || ! kill -0 "$daemon_pid" 2>/dev/null; }; then
  echo "::error::runner keychain unavailable: the keyring daemon ended during the run ($restart_count restart(s)) and the command failed. Treat this failure as a runner problem and re-run; no test was weakened."
fi

if ! kill -0 "$daemon_pid" 2>/dev/null; then
  daemon_status=0
  wait "$daemon_pid" || daemon_status=$?
  how="exit status $daemon_status"
  if [ "$daemon_status" -gt 128 ]; then how="signal $((daemon_status - 128))"; fi
  echo "::warning::gnome-keyring-daemon ended before the command did ($how); D-Bus restarted it on the same passwordless keyring. End of its output:"
  tail -n 20 "$log" || true
fi

exit "$status"
