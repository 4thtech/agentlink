#!/usr/bin/env bash
# PROC-ORCH-PLAYBOOK (docs/process/orchestrator-playbook.md §5.6): background merge-queue watcher.
# Exits (and so wakes the orchestrator) when one of the key PRs merges or any merge-queue entry
# is UNMERGEABLE. Run it once with the harness's background mode instead of polling by hand.
#
# usage: tools/orchestrator/watch-queue.sh <pr> [<pr> ...]
# env:   WATCH_REPO (default 4thtech/agentlink), WATCH_INTERVAL seconds (default 120)
set -uo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <pr> [<pr> ...]" >&2
  exit 2
fi
for n in "$@"; do
  case "$n" in
    '' | *[!0-9]*) echo "not a PR number: $n" >&2; exit 2 ;;
  esac
done

repo="${WATCH_REPO:-4thtech/agentlink}"
interval="${WATCH_INTERVAL:-120}"
owner="${repo%%/*}"
name="${repo##*/}"
query="{repository(owner:\"$owner\",name:\"$name\"){mergeQueue(branch:\"main\"){entries(first:50){nodes{state pullRequest{number}}}}}}"

while true; do
  for n in "$@"; do
    s="$(gh pr view "$n" --repo "$repo" --json state --jq .state 2>/dev/null)"
    if [ "$s" = "MERGED" ]; then
      echo "$(date -u +%H:%MZ) MERGED #$n"
      exit 0
    fi
  done
  u="$(gh api graphql -f query="$query" \
    --jq '.data.repository.mergeQueue.entries.nodes[] | select(.state=="UNMERGEABLE") | .pullRequest.number' \
    2>/dev/null | tr '\n' ' ')"
  if [ -n "${u// /}" ]; then
    echo "$(date -u +%H:%MZ) UNMERGEABLE #${u% }"
    exit 0
  fi
  sleep "$interval"
done
