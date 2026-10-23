#!/usr/bin/env bash
# CHORE-CI-PLAYWRIGHT-3: how many seconds one bounded sub-step of install-playwright may use.
# Usage: budget.sh <cap-seconds>. DEADLINE (epoch seconds) comes from the action's first step.
# Prints min(cap, seconds left before DEADLINE). Fails (exit 1, message on stderr) when fewer than
# 15 seconds are left, so the action stops with a clear error before the caller's timeout-minutes
# ends it with "The action has timed out". Without a valid DEADLINE the cap alone applies.
set -euo pipefail

cap="${1:-}"
if [[ ! "$cap" =~ ^[1-9][0-9]{0,4}$ ]]; then
  echo "budget.sh: the cap must be a positive number of seconds" >&2
  exit 2
fi
deadline="${DEADLINE:-}"
if [[ ! "$deadline" =~ ^[0-9]{9,11}$ ]]; then
  echo "$cap"
  exit 0
fi
left=$((deadline - $(date +%s)))
if ((left < 15)); then
  echo "::error::Install Playwright browsers: the time budget is used up (${left}s left); stopping before the step's time limit." >&2
  exit 1
fi
if ((left < cap)); then echo "$left"; else echo "$cap"; fi
