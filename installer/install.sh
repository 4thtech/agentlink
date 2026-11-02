#!/bin/sh
# AgentLink installer for macOS and Linux (INSTALLER-1, owner Decision 58).
#
#   curl -fsSL https://agentlink.4thtech.io/install.sh | sh
#   curl -fsSL https://agentlink.4thtech.io/install.sh | sh -s -- --dry-run
#   curl -fsSL https://agentlink.4thtech.io/install.sh | sh -s -- --uninstall
#
# What it does, and nothing more:
#   1. Uses your Node.js if it is 22.14 or newer. Otherwise it downloads the official Node.js
#      (NODE_VERSION below) from nodejs.org into ~/.agentlink/runtime, after checking its SHA-256
#      against nodejs.org's SHASUMS256.txt AND against the hash written in this file.
#   2. Writes a small `agentlink` command to ~/.agentlink/bin and adds that folder to PATH in your
#      shell profile (one marked line).
#   3. Starts AgentLink (only when run from a terminal).
# No sudo, no admin rights, no telemetry. It never asks for or prints a secret. Run it again to
# update. Your IDs and messages (the rest of ~/.agentlink) are never touched, not even by --uninstall.
#
# POSIX sh (not bash); `shellcheck installer/install.sh` is clean. Source: installer/ in
# https://github.com/4thtech/agentlink (MIT).

# Everything runs inside main, called on the last line: a cut-off download runs nothing.
main() {
  set -eu
  umask 022

  NODE_VERSION=22.23.4
  NODE_MIN_MAJOR=22
  NODE_MIN_MINOR=14
  NODE_DIST="https://nodejs.org/dist/v$NODE_VERSION"
  PACKAGE="@4thtech-io/agentlink@latest"
  MARK="# added by the AgentLink installer"

  dry_run=0
  uninstall=0
  start=1
  for arg in "$@"; do
    case "$arg" in
      --dry-run) dry_run=1 ;;
      --uninstall) uninstall=1 ;;
      --no-start) start=0 ;;
      -h | --help)
        echo "Usage: install.sh [--dry-run] [--uninstall] [--no-start]"
        return 0
        ;;
      *) fail "Unknown option: $arg (try --help)." ;;
    esac
  done

  [ -n "${HOME:-}" ] || fail "HOME is not set."
  base="$HOME/.agentlink"
  bin_dir="$base/bin"
  runtime_root="$base/runtime"
  launcher="$bin_dir/agentlink"

  if [ "$uninstall" -eq 1 ]; then
    do_uninstall
    return 0
  fi

  detect_platform
  say "Installing AgentLink for $os_label."

  node_bin=""
  if use_existing_node; then
    say "Using your Node.js $found_version."
  else
    node_bin="$runtime_root/node-v$NODE_VERSION-$platform/bin"
    if [ -x "$node_bin/node" ] && [ -x "$node_bin/npx" ]; then
      say "Node.js $NODE_VERSION is already installed for AgentLink."
    else
      install_node
    fi
  fi

  write_launcher
  add_to_path

  if [ "$dry_run" -eq 1 ]; then
    say "Dry run: nothing was changed."
    return 0
  fi

  say "AgentLink is installed. Next time, open a new terminal and type: agentlink"
  if [ "$start" -eq 1 ] && [ -t 1 ] && { : </dev/tty; } 2>/dev/null; then
    say "Starting AgentLink. Your browser opens the app. Press Ctrl+C here to close it."
    "$launcher" </dev/tty
  else
    say "To start it now, run: $launcher"
  fi
}

say() { printf '%s\n' "$*"; }
fail() {
  printf 'AgentLink installer: %s\n' "$*" >&2
  exit 1
}

# Removes the download folder, if there is one.
cleanup() {
  if [ -n "${tmp:-}" ]; then rm -rf "$tmp"; fi
  tmp=""
}

# Runs a command, or only prints it with --dry-run.
act() {
  if [ "$dry_run" -eq 1 ]; then say "  would run: $*"; else "$@"; fi
}

detect_platform() {
  case "$(uname -s)" in
    Darwin) os=darwin os_label=macOS ;;
    Linux) os=linux os_label=Linux ;;
    *) fail "This installer is for macOS and Linux. On Windows, use install.ps1 (see https://agentlink.4thtech.io)." ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) arch=x64 ;;
    arm64 | aarch64) arch=arm64 ;;
    *) fail "This computer's processor ($(uname -m)) is not supported yet." ;;
  esac
  platform="$os-$arch"
}

# The SHA-256 of each Node.js archive, copied from nodejs.org's SHASUMS256.txt for v22.23.4, whose
# release signature (Antoine du Hamel, a Node.js release key) was checked when it was pinned.
pinned_sha() {
  case "$1" in
    darwin-arm64) echo c9e1dbc748b33ed2d14f42445191ecaf14c56259c7a9a26d0042c49ec2b66428 ;;
    darwin-x64) echo efcc2b0db6f94bf53eddb038fe2b370277a042bd29e4f19b8f8e23598795b819 ;;
    linux-arm64) echo f7a1e486dbc8b286847815b477d4fb5e9fb963ed4489c3e1588853d685f589f9 ;;
    linux-x64) echo b8492284c76a54baf58d61668dd0e41ee0fc98adabf9503d30f05d08f55b4406 ;;
    *) echo "" ;;
  esac
}

# True when `node` and `npx` on PATH are Node.js 22.14 or newer; sets node_bin and found_version.
use_existing_node() {
  found_version=""
  command -v node >/dev/null 2>&1 || return 1
  found_version="$(node -p 'process.versions.node' 2>/dev/null)" || return 1
  major="${found_version%%.*}"
  rest="${found_version#*.}"
  minor="${rest%%.*}"
  case "$major$minor" in '' | *[!0-9]*) return 1 ;; esac
  if [ "$major" -lt "$NODE_MIN_MAJOR" ] ||
    { [ "$major" -eq "$NODE_MIN_MAJOR" ] && [ "$minor" -lt "$NODE_MIN_MINOR" ]; }; then
    say "Your Node.js $found_version is older than $NODE_MIN_MAJOR.$NODE_MIN_MINOR, so AgentLink gets its own copy."
    return 1
  fi
  node_path="$(command -v node)"
  node_bin="$(cd "$(dirname "$node_path")" && pwd)"
  [ -x "$node_bin/npx" ] || return 1
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    fail "No SHA-256 tool found (sha256sum or shasum), so the download cannot be checked."
  fi
}

download() { # <url> <file>
  curl -fsSL --proto '=https' --tlsv1.2 --retry 2 -o "$2" "$1" ||
    fail "Could not download $1. Check your internet connection and run the installer again."
}

install_node() {
  if [ -f /etc/alpine-release ]; then
    fail "Alpine Linux needs Node.js 22.14 or newer from its own packages (apk add nodejs npm). Then run this installer again."
  fi
  command -v curl >/dev/null 2>&1 || fail "curl is needed to download Node.js."
  archive="node-v$NODE_VERSION-$platform.tar.gz"
  pinned="$(pinned_sha "$platform")"
  [ -n "$pinned" ] || fail "There is no Node.js download for $platform."
  say "Downloading Node.js $NODE_VERSION from nodejs.org (about 50 MB)."
  if [ "$dry_run" -eq 1 ]; then
    say "  would download $NODE_DIST/$archive and SHASUMS256.txt, check SHA-256 $pinned,"
    say "  and unpack it into $runtime_root"
    return 0
  fi
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/agentlink-install.XXXXXX")" ||
    fail "Could not create a temporary folder."
  # Removed right after the move below, and on any abort before that (Ctrl+C included).
  trap 'cleanup' EXIT
  trap 'cleanup; exit 130' INT TERM
  download "$NODE_DIST/$archive" "$tmp/$archive"
  download "$NODE_DIST/SHASUMS256.txt" "$tmp/SHASUMS256.txt"
  listed="$(awk -v f="$archive" '$2 == f { print $1 }' "$tmp/SHASUMS256.txt")"
  actual="$(sha256_of "$tmp/$archive")"
  if [ "$actual" != "$listed" ] || [ "$actual" != "$pinned" ]; then
    fail "The Node.js download did not pass its safety check (SHA-256 mismatch), so nothing was installed. Please try again later."
  fi
  say "Checked: the download matches nodejs.org and this installer."
  ensure_base
  mkdir -p "$runtime_root" || fail "Could not create $runtime_root."
  tar -xzf "$tmp/$archive" -C "$tmp" || fail "Could not unpack the Node.js download."
  rm -rf "$runtime_root/node-v$NODE_VERSION-$platform"
  mv "$tmp/node-v$NODE_VERSION-$platform" "$runtime_root/" || fail "Could not install Node.js into $runtime_root."
  cleanup
  trap - EXIT INT TERM
  # Older AgentLink runtimes are replaced by this one.
  for old in "$runtime_root"/node-v*; do
    [ "$old" = "$runtime_root/node-v$NODE_VERSION-$platform" ] || rm -rf "$old"
  done
}

# ~/.agentlink also holds your IDs, so a new one is private to you (as AgentLink makes it).
ensure_base() {
  [ -d "$base" ] || mkdir -m 700 "$base"
}

# Prints $1 as one single-quoted sh word.
quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

write_launcher() {
  say "Adding the agentlink command: $launcher"
  if [ "$dry_run" -eq 1 ]; then
    say "  would run: $node_bin/npx -y $PACKAGE"
    return 0
  fi
  ensure_base
  mkdir -p "$bin_dir"
  {
    echo '#!/bin/sh'
    echo "# AgentLink launcher, written by https://agentlink.4thtech.io/install.sh."
    echo "# Remove with: curl -fsSL https://agentlink.4thtech.io/install.sh | sh -s -- --uninstall"
    echo "PATH=$(quote "$node_bin"):\"\$PATH\""
    echo 'export PATH'
    # npm reads a project .npmrc from the folder it is started in (node-options, proxies, TLS...).
    # --prefix points that lookup at our own folder instead, and the registry is pinned on the
    # command line. The start folder is kept: `agentlink verify ./pack` names files relative to it.
    echo "exec $(quote "$node_bin/npx") -y --prefix=$(quote "$base") --registry=https://registry.npmjs.org/ --@4thtech-io:registry=https://registry.npmjs.org/ $PACKAGE \"\$@\""
  } >"$launcher.tmp"
  chmod 755 "$launcher.tmp"
  mv "$launcher.tmp" "$launcher"
}

# The profile files that get the PATH line: ~/.profile always, plus the files of zsh and bash
# when you use them.
profiles() {
  echo "$HOME/.profile"
  case "${SHELL:-}" in
    */zsh) echo "$HOME/.zshrc" ;;
    */bash)
      if [ "$os" = darwin ]; then echo "$HOME/.bash_profile"; else echo "$HOME/.bashrc"; fi
      ;;
  esac
}

add_to_path() {
  line="export PATH=\"\$HOME/.agentlink/bin:\$PATH\" $MARK"
  profiles | while IFS= read -r file; do
    if [ -f "$file" ] && grep -F "$MARK" "$file" >/dev/null 2>&1; then continue; fi
    say "Adding ~/.agentlink/bin to PATH in $file"
    [ "$dry_run" -eq 1 ] || printf '\n%s\n' "$line" >>"$file"
  done
}

do_uninstall() {
  say "Removing the AgentLink command and its Node.js copy."
  act rm -rf "$bin_dir" "$runtime_root"
  for file in "$HOME/.profile" "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile"; do
    if ! { [ -f "$file" ] && grep -F "$MARK" "$file" >/dev/null 2>&1; }; then continue; fi
    say "Removing the PATH line from $file"
    if [ "$dry_run" -eq 0 ]; then
      grep -vF "$MARK" "$file" >"$file.agentlink-tmp" || true
      cat "$file.agentlink-tmp" >"$file"
      rm -f "$file.agentlink-tmp"
    fi
  done
  say "Done. Your IDs, contacts and messages in ~/.agentlink were kept."
}

main "$@"
