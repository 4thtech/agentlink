#!/usr/bin/env bash
# CHORE-CI-PLAYWRIGHT-3: puts cached .deb files into apt's archive directory only when their
# SHA-256 equals the one apt's signed package index lists for that exact package and version
# (run after `apt-get update`). apt then installs them without downloading; anything else (odd
# name, unreadable control data, unknown package or version, different hash) is left out and apt
# downloads it from the mirror as usual. Nothing here installs a package.
# Usage: verify-debs.sh <cache-dir> <archives-dir>
set -uo pipefail

src="${1:?usage: verify-debs.sh <cache-dir> <archives-dir>}"
dest="${2:?usage: verify-debs.sh <cache-dir> <archives-dir>}"
seeded=0
skipped=0
shopt -s nullglob
for f in "$src"/*.deb; do
  name="${f##*/}"
  if [[ ! "$name" =~ ^[A-Za-z0-9][A-Za-z0-9.+~%_-]*\.deb$ ]] || [ -L "$f" ] || [ ! -f "$f" ]; then
    skipped=$((skipped + 1))
    continue
  fi
  # Copy first, then check the copy, so the file apt sees is the file that was hashed.
  tmp="$dest/$name.agentlink-partial"
  if ! cp -- "$f" "$tmp" 2>/dev/null; then
    skipped=$((skipped + 1))
    continue
  fi
  pkg="$(dpkg-deb -f "$tmp" Package 2>/dev/null)" || pkg=""
  ver="$(dpkg-deb -f "$tmp" Version 2>/dev/null)" || ver=""
  if [[ ! "$pkg" =~ ^[a-z0-9][a-z0-9.+-]*$ ]] || [[ ! "$ver" =~ ^[A-Za-z0-9][A-Za-z0-9.+~:-]*$ ]]; then
    rm -f -- "$tmp"
    skipped=$((skipped + 1))
    continue
  fi
  want="$(apt-cache show "$pkg=$ver" 2>/dev/null | awk '$1 == "SHA256:" { print $2 }')"
  have="$(sha256sum -- "$tmp" | awk '{ print $1 }')"
  if [[ "$have" =~ ^[0-9a-f]{64}$ ]] && printf '%s\n' "$want" | grep -qxF -- "$have"; then
    if chmod 0644 "$tmp" && mv -f "$tmp" "$dest/$name"; then
      seeded=$((seeded + 1))
    else
      rm -f -- "$tmp"
      skipped=$((skipped + 1))
    fi
  else
    rm -f -- "$tmp"
    skipped=$((skipped + 1))
  fi
done
echo "seeded=$seeded skipped=$skipped"
