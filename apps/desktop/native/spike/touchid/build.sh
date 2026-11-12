#!/bin/sh
# DESK-TOUCHID-SPIKE: builds the owner-local test app into /Users/Shared/AgentLink-test (never shipped).
# The real helper is built from apps/desktop/native/macos/agentlink-presence.swift, unchanged.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
DESKTOP=$(cd "$HERE/../../.." && pwd)
OUT=/Users/Shared/AgentLink-test
APP="$OUT/AgentLink Touch ID test.app"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
# Same steps as apps/desktop/build/native.mjs macBuildPlan (arm64), without its package imports.
mkdir -p "$WORK/helper"
swiftc -O -swift-version 5 -target arm64-apple-macos13.0 \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$DESKTOP/native/macos/Info.plist" \
  "$DESKTOP/native/macos/agentlink-presence.swift" -o "$WORK/helper/agentlink-presence"
codesign --force --sign - --identifier io.4thtech.agentlink.presence --options runtime "$WORK/helper/agentlink-presence"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Helpers"
cp "$HERE/Info.plist" "$APP/Contents/Info.plist"
cp "$WORK/helper/agentlink-presence" "$APP/Contents/Helpers/agentlink-presence"
swiftc -O -target arm64-apple-macos13.0 "$HERE/spike-helper.swift" -o "$APP/Contents/Helpers/touchid-spike-helper"
swiftc -O -target arm64-apple-macos13.0 "$HERE/TouchIDSpike.swift" -o "$APP/Contents/MacOS/TouchIDSpike"
codesign --force --sign - --identifier io.4thtech.agentlink.spike-helper --options runtime "$APP/Contents/Helpers/touchid-spike-helper"
codesign --force --sign - "$APP"
echo "$APP"
