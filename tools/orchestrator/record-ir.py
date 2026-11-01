#!/usr/bin/env python3
"""Record an independent-review (IR) line in a PR body's '## Independent review' section.

PROC-ORCH-PLAYBOOK (docs/process/orchestrator-playbook.md §6). Orchestrator tool; workers never
run it (a worker never writes an IR verdict).

usage:
  record-ir.py <pr> "<IR line>" [--owner-merge "<text>"] [--repo owner/name] [--dry-run]
               [--body-file <path>]

  <IR line>     must start with `IR-<ID>-<n>: PASS`, e.g.
                `IR-M1-5-1: PASS at <full sha> (Opus 5.5, fresh context; summary)` or
                `IR-M1-5-2: PASS (mechanical) at <full sha> (Haiku 5.5, D-126 verifier; clean merge)`
  --owner-merge record the owner's merge go-ahead line (e.g. his standing order as he worded it
                in chat) once in the section. Opt-in: pass it only while the owner's order stands
                (orchestrator-playbook.md §5); without it no merge line is added
  --dry-run     print the new body to stdout; do not edit the PR
  --no-rerun    do not re-run a failed review-gate run after recording (OPS-MERGE-FRICTION)
  --body-file   read the current body from a local file instead of `gh pr view` (tests, offline)

Behaviour: replaces 'Pending (orchestrator).' with the line (or appends it below earlier IR
lines) and, only with --owner-merge, adds that line once. Refuses when the line is not a PASS line, when
the body has no '## Independent review' section, or when the section would contain
'verdict ... fail'. After recording it looks up the latest `Review gate` run for the PR head
commit (waiting up to RECORD_IR_WAIT seconds, default 90, for one in flight); if that run failed
it re-runs only that run (`gh run rerun <id>`) and says so. It never re-runs a passing, running
or older run, so concurrent re-runs cannot cancel each other. The new body is written to a private temp file and passed to
`gh pr edit --body-file`; the temp file is removed afterwards.
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import time

GH = os.environ.get("RECORD_IR_GH", "gh")  # tests point this at a fake gh

PASS_RE = re.compile(r"^IR-[A-Za-z0-9._-]+-\d+: PASS")
SECTION_RE = re.compile(r"(## Independent review[^\n]*\n)(.*?)(?=\n## |\Z)", re.S)


def refuse(msg):
    sys.exit(f"refuse: {msg}")


def new_body(body, line, order=None):
    """Return the body with `line` recorded, or exit with a refusal."""
    if not PASS_RE.match(line):
        refuse("line must start with IR-<ID>-<n>: PASS")
    body = body.replace("\r\n", "\n")
    m = SECTION_RE.search(body)
    if not m:
        refuse("no '## Independent review' section")
    sec = m.group(2)
    entry = line if not order or order in sec else f"{line}\n{order}"
    if "Pending (orchestrator)." in sec:
        new = sec.replace("Pending (orchestrator).", entry, 1)
    else:
        new = sec.rstrip("\n") + f"\n\n{entry}\n"
    if re.search(r"verdict[^\n]*fail", new, re.I):
        refuse("section would contain 'verdict ... fail'")
    return body[: m.start(2)] + new + body[m.end(2):]


def rerun_stale_gate(pr, repo, wait=None):
    """Re-run the latest failed `Review gate` run for the PR head, and only that one."""
    wait = int(os.environ.get("RECORD_IR_WAIT", "90")) if wait is None else wait
    try:
        sha = json.loads(subprocess.check_output(
            [GH, "pr", "view", pr, "--repo", repo, "--json", "headRefOid"]))["headRefOid"]
        deadline = time.time() + wait
        while True:
            runs = json.loads(subprocess.check_output(
                [GH, "run", "list", "--repo", repo, "--workflow", "Review gate", "--commit", sha,
                 "--json", "databaseId,status,conclusion,createdAt", "--limit", "20"]))
            if not runs:
                print(f"no review-gate run found for {sha[:12]}; nothing to re-run")
                return
            latest = max(runs, key=lambda r: r["createdAt"])
            if latest["status"] != "completed" and time.time() < deadline:
                time.sleep(5)
                continue
            break
        if latest["status"] != "completed":
            print(f"review-gate run {latest['databaseId']} is still {latest['status']}; left alone")
        elif latest["conclusion"] in ("failure", "timed_out"):
            subprocess.check_call([GH, "run", "rerun", str(latest["databaseId"]), "--repo", repo])
            print(f"re-ran review-gate run {latest['databaseId']} (was {latest['conclusion']})")
        else:
            print(f"review-gate run {latest['databaseId']} is {latest['conclusion']}; no re-run needed")
    except (subprocess.CalledProcessError, KeyError, ValueError) as e:
        print(f"warning: could not re-run review-gate ({e}); re-run that one run by hand",
              file=sys.stderr)


def main(argv):
    args = list(argv)
    repo = "4thtech/agentlink"
    dry_run = False
    body_file = None
    order = None
    if "--repo" in args:
        i = args.index("--repo")
        repo = args[i + 1]
        del args[i:i + 2]
    if "--owner-merge" in args:
        i = args.index("--owner-merge")
        order = args[i + 1].strip()
        del args[i:i + 2]
        if not order or "\n" in order:
            refuse("--owner-merge needs one non-empty line")
    if "--body-file" in args:
        i = args.index("--body-file")
        body_file = args[i + 1]
        del args[i:i + 2]
    rerun = "--no-rerun" not in args
    if not rerun:
        args.remove("--no-rerun")
    if "--dry-run" in args:
        args.remove("--dry-run")
        dry_run = True
    if len(args) != 2:
        sys.exit(__doc__)
    pr, line = args
    if not re.fullmatch(r"\d+", pr):
        refuse("PR must be a number")

    if body_file:
        with open(body_file, encoding="utf-8") as f:
            body = f.read()
    else:
        body = json.loads(subprocess.check_output(
            [GH, "pr", "view", pr, "--repo", repo, "--json", "body"]))["body"]

    out = new_body(body, line, order)
    if dry_run:
        sys.stdout.write(out)
        return

    fd, path = tempfile.mkstemp(prefix=f"record-ir-pr-{pr}-", suffix=".md")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(out)
        subprocess.check_call([GH, "pr", "edit", pr, "--repo", repo, "--body-file", path])
    finally:
        os.unlink(path)
    print(f"recorded on #{pr}: {line}")
    if rerun:
        rerun_stale_gate(pr, repo)


if __name__ == "__main__":
    main(sys.argv[1:])
