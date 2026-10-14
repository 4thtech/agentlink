# RB-03 · Writing a worker brief

## Purpose
Give a worker everything it needs and nothing it does not: one outcome, the files it owns, the files it must not touch, the stop conditions, and an explicit invitation to challenge the brief.

## When to use
Every time the orchestrator delegates work, read-only or write. A survey worker gets a short brief with `Mode: read-only`; a builder gets the full template.

## Who runs it
The orchestrator (Opus 5.5). It picks the worker's tier with the routing procedure in `development-process.md` §3.2; when in doubt, route up.

## Preconditions
- The task is claimed ([RB-02](claim-task.md)) and its worktree exists, if it writes.
- You know the security class, the spec sections and the invariants in scope.
- For parallel builders: you have split the files so that **no file has two owners**.

## Steps
1. Copy the brief template from `development-process.md` §4.1. Every field is required; write "none" where empty.
2. Add these lines below it. They come from `delivery-process.md` §2 (step 3) and §3.1 and are part of every brief here:
   ```text
   Check the reasoning:  Check the reasoning you are given; do not just agree with it.
                         If the brief, the card or the spec looks wrong, say so in ESCALATIONS.
   Owned files:          <exact paths or globs this worker may write>
   Owned by others:      <paths other workers own right now: hands off, read only>
   Never:                Do not merge, do not deploy, do not push, do not open PRs
                         (except: push this task branch when this brief says so, as CI
                         runs on the push; never open the PR, the orchestrator does
                         that after the review; never touch main), do not write the
                         sync branch or the Curator.
   Scratch files:        <scratch dir>/<unique prefix>-*   (never a shared fixed name)
   Lessons in scope:     <LL-nn links that apply, e.g. LL-05 for dependency work>
   Report:               §4.3 format, at most 400 words; long output goes to files.
   ```
3. Paste the forbidden-actions list of §4.2 verbatim, plus any task-specific ones.
4. State the acceptance criteria as AC-1 … AC-n, each mapped to a test or a command. For new tests, require a negative control ([RB-05](writing-tests.md)).
5. Name the exact commands to run (`pnpm lint`, `pnpm typecheck`, `pnpm test`, or the package-scoped variants).
6. Launch. In Claude Code: the Agent tool with `model` set per the routing table and `isolation: "worktree"` for parallel writers. Run independent workers in parallel and in the background.

## Verify
- Read the brief once as the worker: can it start without asking anything? Does every AC have a command?
- For parallel builders, the union of "Owned files" has no overlap: list them and check by eye or with `sort | uniq -d`.
- When the report arrives, run the verification protocol (`development-process.md` §5). The report is a claim, not evidence.

## If it fails
- **`STATUS: escalate`:** re-route up a tier, split the task, or ask the owner (§3.3). Never re-run the same tier with "try harder".
- **The worker wrote outside its owned files:** reject the change for those files, find out why (was the brief wrong?), and re-brief.
- **The worker agreed with a wrong brief:** fix the brief, not only the output, and consider a lesson ([`../lessons/`](../lessons/README.md)).

## Related
- Rules: [`development-process.md`](../process/development-process.md) §3 (routing), §4 (brief, forbidden actions, report), §5 (verification); [`delivery-process.md`](../process/delivery-process.md) §2–§3.
- [RB-04 independent review](independent-review.md): reviewers get a different, much smaller input set.
