# RB-04 · Running an independent review

## Purpose
Have a fresh reviewer, who never saw how the work was built, try to break it from the spec and the branch diff alone, and record the result as `IR-<TASK-ID>-<k>` so `review-gate` and the owner can see it. The review happens **before the PR exists**; the PR opens afterwards with the result already in it.

## When to use
Every S1 and S2 branch before its PR is opened (`audit-rules.md` §3); optional (a Sonnet review) for S0. Again after fix commits: a **delta review** with the next number.

## Who runs it
The orchestrator spawns it and handles the result. The reviewer is a **different, fresh-context Opus 5.5 worker** in read-only mode, or a non-author human engineer. Never the builder, and never the orchestrator that integrated the work (`development-process.md` §3.4).

## Preconditions
- The builder's work is committed and pushed to its task branch; CI has run on the head commit (`gh run list --branch <branch>`). There is no PR yet.
- You know the class and the areas touched (to choose the `audit-rules.md` §5 checklists).
- S2: you have the RED commit SHA, its test command and the stated failure reason from the builder's report (they reach the PR body later). They are facts to reproduce, not the builder's rationale.
- Review number `<k>` is 1 for the first review of a task, then 2, 3 … for each delta review (for example `IR-M1-5a-1`, then `IR-M1-5a-2`).

## Steps
1. Write the diff and the CI result to scratch files; the reviewer reads files, not your context:
   ```bash
   git fetch origin
   git diff origin/main...<branch> > <scratch>/rb-<TASK-ID>-ir<k>.diff
   gh run list --branch <branch> --limit 5 > <scratch>/rb-<TASK-ID>-ir<k>-ci.txt
   ```
2. Spawn the reviewer with **only** the inputs of `audit-rules.md` §4.1: the spec sections (04 in full for S2), the invariants, the diff file, the CI output, read-only access to the head commit, and the §5 checklists. **Not** the brief, the builder's report, the PR body, commit messages, the threat note, Curator content or sync files.
   For S2 also pass the RED commit SHA and the test command, and tell it: "check out the RED commit in a scratch worktree, confirm it is an ancestor of the head and holds only tests, run the command, and confirm it fails for the stated reason; record `tests-first reproduced: yes|no`" (`audit-rules.md` §3.4). A `no` is a finding.
3. Tell it the procedure (§4.2: every checklist item gets `finding <ID>`, `no finding` or `n/a: <reason>`; S2 adds the invariant walkthrough with file:line) and the output format (§4.3), with the report ID `IR-<TASK-ID>-<k>` and "write the full report to `<scratch>/IR-<TASK-ID>-<k>.md`".
4. For a delta review, add the prior finding list (IDs and titles only) and the new commit range. The reviewer verifies each prior fix and reviews the new commits.
5. When the report arrives, forward it **verbatim** to the owner. Never edit, merge or drop findings (§4.4).
6. Fix rounds: send each finding to the builder as a fix item. Judgement calls are decided in favour of safety or escalated to the owner (`delivery-process.md` §2, step 6). Then repeat from step 1 with `<k>+1`.
7. File the full report privately: `4thtech/agentlink-ops` → `audits/reviews/IR-<TASK-ID>-<k>.md`, through a PR in that repository (private runbook "Filing audit and independent-review reports"). It may contain unfixed details, so it never goes into the public repo.
8. Once the review passes (and its findings are fixed), open the PR (not a draft) with the one-line summary already in its **Independent review** section, so `review-gate` is green on the first run:
   ```text
   IR-<TASK-ID>-<k> · Verdict: PASS WITH FINDINGS · 0 Critical, 0 High, 2 Medium, 1 Low · tracker <IDs> · report: agentlink-ops audits/reviews/IR-<TASK-ID>-<k>.md
   ```
   The literal word `Verdict:` is required: `review-gate` detects a FAIL only as "Verdict: FAIL" and would miss a line like "IR-X-1: FAIL".

## Verify
- The PR line contains `IR-<TASK-ID>-<k>` and `Verdict: <PASS|PASS WITH FINDINGS|FAIL>`.
- `gh pr checks <n>` shows `review-gate` green on the PR's first run (it looks for the `IR-` ID and fails on "Verdict: FAIL").
- Every finding has a disposition (§9.4) in the PR or the tracker before the PR leaves `audit`.
- The ops PR with the report exists, or is merged on the owner's instruction.

## If it fails
- **Verdict FAIL:** no PR is opened. Fix, then a delta review with the next number. The PR line names the latest review. If a delta review is needed after the PR exists, edit the PR line.
- **Reviewer saw contaminated input** (a builder report slipped in): discard the review and run a new one with a new number; record why.
- **Reviewer and builder disagree on a finding:** the orchestrator does not decide alone on security; escalate to the owner with both positions quoted.

## Related
- Rules: [`audit-rules.md`](../process/audit-rules.md) §3, §4 (inputs, procedure, format, handling, storage), §5 (checklists), §9 (findings); [`development-process.md`](../process/development-process.md) §5 step 8.
