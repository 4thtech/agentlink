#!/bin/sh
# DESK-TOUCHID-ROOTCAUSE: owner-local Touch ID check (never shipped). Double-click in Finder.
# Three Touch ID boxes, one after another. For each one it records the helper's exit and, from the
# system log, whether the fingerprint SENSOR CHIP itself felt a finger while the box was up
# (kernel "kAppleBiometricFingerOnEvent"). That separates "macOS refused our helper" from
# "no finger contact reached the sensor".
#   1 control   an Apple-signed process (swift-frontend) asks; no key
#   2 helper    the real agentlink-presence helper asks, started from this Terminal window
#   3 app       the test app's "Try A" (helper started by the app, code field focused = today's failure)
# Keys are throwaway Secure Enclave keys (no keychain item). Nothing secret is printed or kept.
# Result lines (fixed shape) go to the file next to this script: touchid-check-result.txt
HERE=$(cd "$(dirname "$0")" && pwd)
APP="$HERE/AgentLink Touch ID test.app"
HELPER="$APP/Contents/Helpers/agentlink-presence"
OUT="$HERE/touchid-check-result.txt"
CORELOG="$HOME/Library/Logs/AgentLink/core.log"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
: > "$OUT"

finger_felt() { # $1 = start "YYYY-MM-DD HH:MM:SS"
  n=$(/usr/bin/log show --start "$1" --info \
    --predicate 'process == "kernel" AND eventMessage CONTAINS "kAppleBiometricFingerOnEvent"' 2>/dev/null |
    grep -c "kAppleBiometricFingerOnEvent")
  [ "${n:-0}" -gt 0 ] && echo 1 || echo 0
}

report() { # name exit diag start-epoch start-stamp
  secs=$(($(date +%s) - $4))
  sleep 1
  felt=$(finger_felt "$5")
  echo "test=$1 exit=$2 diag=$3 finger_felt=$felt seconds=$secs" >> "$OUT"
  if [ "$2" = 0 ]; then word="WORKED"; else word="did not work"; fi
  if [ "$felt" = 1 ]; then f="the sensor felt your finger"; else f="the sensor did NOT feel a finger"; fi
  echo "   -> $word; $f."
  echo
}

clear
echo "Touch ID check: 3 boxes. Each time a Touch ID box appears, rest your finger on the"
echo "Touch ID key (top-right key of the keyboard) for 2 seconds. Do not click anything in the box."
echo

echo "Box 1 of 3 is coming (takes a few seconds)..."
t=$(date +%s); s=$(date "+%Y-%m-%d %H:%M:%S")
d=$(/usr/bin/swift "$HERE/touchid-check-control.swift" 2>/dev/null | tail -1)
case "$d" in none) x=0 ;; sheet_la_-[0-9]*) x=10 ;; sensor_la_-[0-9]*) x=69 ;; *) d=not_run x=70 ;; esac
report control "$x" "$d" "$t" "$s"

echo "Box 2 of 3 is coming..."
"$HELPER" create > "$WORK/rec" 2>/dev/null
t=$(date +%s); s=$(date "+%Y-%m-%d %H:%M:%S")
"$HELPER" ecdh setup < "$WORK/rec" > /dev/null 2> "$WORK/err"; x=$?
d=$(tr ' ' '_' < "$WORK/err" | head -1); [ -n "$d" ] || d=none
report helper "$x" "$d" "$t" "$s"

echo "Box 3 of 3: a small window \"AgentLink Touch ID test\" opens. Type one letter in its box,"
echo "click \"Try A\", then rest your finger on the Touch ID key when the Touch ID box appears."
before=$(grep -c "touchid spike: variant=A" "$CORELOG" 2>/dev/null); before=${before:-0}
t=$(date +%s); s=$(date "+%Y-%m-%d %H:%M:%S")
open "$APP"
i=0
while [ $i -lt 180 ]; do
  now=$(grep -c "touchid spike: variant=A" "$CORELOG" 2>/dev/null); now=${now:-0}
  [ "$now" -gt "$before" ] && break
  sleep 1; i=$((i + 1))
done
line=$(grep "touchid spike: variant=A" "$CORELOG" 2>/dev/null | tail -1)
if [ "${now:-0}" -gt "$before" ]; then
  x=$(echo "$line" | sed -E 's/.* exit=([0-9]+).*/\1/'); d=$(echo "$line" | sed -E 's/.* diag=([a-z_0-9-]+).*/\1/')
else
  x=75; d=not_run
fi
report app "$x" "$d" "$t" "$s"
pkill -x TouchIDSpike > /dev/null 2>&1

echo "Done. Results are saved; tell Claude \"done\". You can close this window."
