#!/usr/bin/env python3
"""Run the required checks on a bot-opened "Version packages" PR (OPS-MERGE-FRICTION).

A PR opened with GITHUB_TOKEN (the Changesets version job) gets its CI and Security runs as
`action_required` ("Approve and run"). Closing and reopening it under the operator's own identity
starts normal runs. This tool does exactly that, automatically and only when needed.

usage: retrigger-version-pr.py <pr> [--repo owner/name] [--dry-run]

Acts only when ALL hold: the PR is open, its author is `github-actions[bot]`, its head branch
starts with `changeset-release/`, and its head commit has at least one run with conclusion
`action_required`. Otherwise it prints why and does nothing. It changes no workflow, check or
branch rule, approves nothing and merges nothing.
"""
import json
import os
import re
import subprocess
import sys

GH = os.environ.get("RECORD_IR_GH", "gh")  # tests point this at a fake gh
BOT_LOGINS = ("app/github-actions", "github-actions[bot]", "github-actions")


def decide(pr_info, runs):
    """Return (act, reason)."""
    if pr_info.get("state") != "OPEN":
        return False, "PR is not open"
    if (pr_info.get("author") or {}).get("login") not in BOT_LOGINS:
        return False, "PR was not opened by github-actions[bot]"
    if not str(pr_info.get("headRefName", "")).startswith("changeset-release/"):
        return False, "head branch is not changeset-release/*"
    waiting = [r for r in runs if r.get("conclusion") == "action_required"]
    if not waiting:
        return False, "no run is waiting for approval"
    return True, f"{len(waiting)} run(s) waiting for approval"


def main(argv):
    args = list(argv)
    repo = "4thtech/agentlink"
    dry = "--dry-run" in args
    if dry:
        args.remove("--dry-run")
    if "--repo" in args:
        i = args.index("--repo")
        repo = args[i + 1]
        del args[i:i + 2]
    if len(args) != 1 or not re.fullmatch(r"\d+", args[0]):
        sys.exit(__doc__)
    pr = args[0]
    info = json.loads(subprocess.check_output(
        [GH, "pr", "view", pr, "--repo", repo, "--json", "state,author,headRefName,headRefOid"]))
    runs = json.loads(subprocess.check_output(
        [GH, "run", "list", "--repo", repo, "--commit", info["headRefOid"],
         "--json", "databaseId,conclusion", "--limit", "50"]))
    act, reason = decide(info, runs)
    if not act:
        print(f"#{pr}: nothing to do ({reason})")
        return
    if dry:
        print(f"#{pr}: would close and reopen ({reason})")
        return
    subprocess.check_call([GH, "pr", "close", pr, "--repo", repo])
    subprocess.check_call([GH, "pr", "reopen", pr, "--repo", repo])
    print(f"#{pr}: closed and reopened to start its checks ({reason})")


if __name__ == "__main__":
    main(sys.argv[1:])
