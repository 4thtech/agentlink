# RB-05 · Writing tests

## Purpose
Write tests that fail when the behaviour is wrong. A test that stays green with the feature removed proves nothing; this runbook is the defence against "everything green and still wrong".

## When to use
Every change that adds or alters behaviour, and every bug fix (a regression test that fails on the pre-fix commit). S2 work (crypto, the policy engine, anything that signs, contracts) is tests-first.

## Who runs it
The builder, at the tier on the card. The orchestrator checks the result in the verification protocol (`development-process.md` §5, steps 4–5).

## Preconditions
- The acceptance criteria are written as AC-1 … AC-n in the brief.
- The monorepo skeleton (M0-2d) is on `main`; packages are still stubs. Commands: [`repo-reference.md`](../process/repo-reference.md).

## Steps
1. **Map each AC to a test** before writing code. Name the test after the behaviour, not the function.
2. **Drive the real path.** Test through the real handler, MCP tool or endpoint the user reaches, not only a helper it calls. A helper-only test once let a job ship disconnected (`delivery-process.md` §3.3).
3. **Fakes must not write what they assert.** If a test double produces the field the test checks, the test proves only the fake. Assert on what the code under test produced.
4. **Area rules from the specs**, for example: every MCP tool gets a schema test and a behaviour test per `status` value, and the D-53 assertions (name starts with `agentlink_`, the four annotations set as in 06 §2.0, `approvalId` on every tool that can return `pending_approval`; card M1-9e); owner-presence tests cover both KeyStore backends, the OS keychain and the file KeyStore of D-54, and never feed an owner secret from an environment variable, file or piped input (`development-process.md` §10).
5. **Use the shapes real users produce**: long inputs, unicode, empty values, the inbound payloads of 06 §9, not only a tidy example.
6. **S2: commit the failing tests first.**
   ```bash
   pnpm --filter <package> test        # red: copy the command and a short excerpt showing the failures
   git commit -m "RED (expected): <TASK-ID> add failing tests for <behaviour>"
   git rev-parse HEAD                    # the SHA for the evidence; do NOT push yet
   ```
   Do not push the RED commit on its own: a red CI run e-mails the owner ([LL-14](../lessons/LL-14-red-ci-emails-owner.md)). Implement in a later commit, then push the branch (own task branch only, and only when the brief says so, `development-process.md` §4.2; otherwise hand back and the orchestrator pushes). CI's first run is then green; the RED commit stays in the history, so do not rebase or squash it away.
   Put the RED commit SHA, the exact command and the output excerpt in the PR's **Tests-first evidence** section (the report to the orchestrator carries them until the PR exists). The independent reviewer reproduces the red ([RB-04](independent-review.md)).
7. **Negative control for every new test.** Break the behaviour on purpose (invert a condition, return early, drop the field), run the test and watch it go red, then restore exactly:
   ```bash
   pnpm --filter <package> exec vitest run <test-file>   # must FAIL with the sabotage
   git checkout -- <source-file>                         # restore exactly
   git diff --exit-code -- <source-file>                 # proves nothing is left behind
   pnpm --filter <package> exec vitest run <test-file>   # green again
   ```
   Record each control in the PR under **Tests added**: "control: removed X → test Y failed". Controls are local only; the broken state is never committed or pushed.
8. **Never weaken** a test, assertion, vector, threshold or lint rule to get green: no `.skip`, `.only`, `--passWithNoTests`, broadened `expect`, lowered coverage. If a test must change, stop and escalate (`development-process.md` §3.3).
9. Run the full set before handing back:
   ```bash
   pnpm lint && pnpm typecheck && pnpm test
   ```
   On a pull request CI tests only the packages the change touches, their dependents and `@4thtech-io/tools`; the merge queue then runs the full suite on the merge with `main`. A test you broke in a package the selector did not name therefore fails only in the queue. Run the changed packages and their dependents before handing back: `pnpm --filter '...<package>' test` ([RB-08](ci-red.md)).

## Verify
- Each AC in the report points to a test name and a command result.
- Each new test has a recorded negative control.
- `git diff origin/main...HEAD -- '*.test.*' | grep -nE '\.skip|\.only|passWithNoTests'` prints nothing.
- S2: the RED commit (tests only) is an ancestor of the head and before the implementation commit: `git merge-base --is-ancestor <RED-SHA> HEAD`. Checking out `<RED-SHA>` and running the recorded command fails for the stated reason. No CI run is red.

## If it fails
- **A negative control stays green:** the test does not test the behaviour. Rewrite it; do not ship it.
- **A flaky test:** see [RB-08](ci-red.md). Fix it; quarantine needs an issue and the owner's approval (`development-process.md` §10).
- **Tests need the network:** unit tests must not. Use a local fake that does not produce the asserted value, or move the case to e2e.

## Related
- Rules: [`development-process.md`](../process/development-process.md) §10 (testing standards) and §7.2 (S2 commit order); [`delivery-process.md`](../process/delivery-process.md) §3.3; [`audit-rules.md`](../process/audit-rules.md) §3 (tests-first evidence).
- [RB-06 cross-runtime test vectors](test-vectors.md).
