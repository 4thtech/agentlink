#!/usr/bin/env python3
"""Record an independent-review (IR) line in a PR body's '## Independent review' section.

PROC-ORCH-PLAYBOOK (docs/process/orchestrator-playbook.md §6). Orchestrator tool; workers never
run it (a worker never writes an IR verdict).

usage:
  record-ir.py <pr> "<IR line>" [--repo owner/name] [--dry-run] [--body-file <path>]

  <IR line>     must start with `IR-<ID>-<n>: PASS`, e.g.
                `IR-M1-5-1: PASS at <full sha> (Opus 5.5, fresh context; summary)` or
                `IR-M1-5-2: PASS (mechanical) at <full sha> (Haiku 5.5, D-126 verifier; clean merge)`
  --dry-run     print the new body to stdout; do not edit the PR
  --body-file   read the current body from a local file instead of `gh pr view` (tests, offline)

Behaviour: replaces 'Pending (orchestrator).' with the line (or appends it below earlier IR
lines) and adds the standing-order line once. Refuses when the line is not a PASS line, when
the body has no '## Independent review' section, or when the section would contain
'verdict ... fail'. The new body is written to a private temp file and passed to
`gh pr edit --body-file`; the temp file is removed afterwards.
"""
import json
import os
import re
import subprocess
import sys
import tempfile

ORDER = "Merge under Tali's standing order 2026-10-22."
PASS_RE = re.compile(r"^IR-[A-Za-z0-9._-]+-\d+: PASS")
SECTION_RE = re.compile(r"(## Independent review[^\n]*\n)(.*?)(?=\n## |\Z)", re.S)


def refuse(msg):
    sys.exit(f"refuse: {msg}")


def new_body(body, line):
    """Return the body with `line` recorded, or exit with a refusal."""
    if not PASS_RE.match(line):
        refuse("line must start with IR-<ID>-<n>: PASS")
    body = body.replace("\r\n", "\n")
    m = SECTION_RE.search(body)
    if not m:
        refuse("no '## Independent review' section")
    sec = m.group(2)
    if "Pending (orchestrator)." in sec:
        new = sec.replace("Pending (orchestrator).", f"{line}\n{ORDER}", 1)
    else:
        new = sec.rstrip("\n") + f"\n\n{line}\n" + ("" if ORDER in sec else f"{ORDER}\n")
    if re.search(r"verdict[^\n]*fail", new, re.I):
        refuse("section would contain 'verdict ... fail'")
    return body[: m.start(2)] + new + body[m.end(2):]


def main(argv):
    args = list(argv)
    repo = "4thtech/agentlink"
    dry_run = False
    body_file = None
    if "--repo" in args:
        i = args.index("--repo")
        repo = args[i + 1]
        del args[i:i + 2]
    if "--body-file" in args:
        i = args.index("--body-file")
        body_file = args[i + 1]
        del args[i:i + 2]
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
            ["gh", "pr", "view", pr, "--repo", repo, "--json", "body"]))["body"]

    out = new_body(body, line)
    if dry_run:
        sys.stdout.write(out)
        return

    fd, path = tempfile.mkstemp(prefix=f"record-ir-pr-{pr}-", suffix=".md")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(out)
        subprocess.check_call(["gh", "pr", "edit", pr, "--repo", repo, "--body-file", path])
    finally:
        os.unlink(path)
    print(f"recorded on #{pr}: {line}")


if __name__ == "__main__":
    main(sys.argv[1:])
