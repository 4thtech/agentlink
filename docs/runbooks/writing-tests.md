# RB-05 · Writing tests

## Purpose
Write tests that fail when the behaviour is wrong. A test that stays green with the feature removed proves nothing; this runbook is the defence against "everything green and still wrong".

## When to use
Every change that adds or alters behaviour, and every bug fix (a regression test that fails on the pre-fix commit). S2 work (crypto, the policy engine, anything that signs, contracts) is tests-first.

## Who runs it
The builder, at the tier on the card. The orchestrator checks the result in the verification protocol (`development-process.md` §5, steps 4–5).

## Preconditions
- The acceptance criteria are written as AC-1 … AC-n in the brief.
- The monorepo skeleton is on `main` (M0-2d); until then there is nothing to run. Commands: [`repo-reference.md`](../process/repo-reference.md).

## Steps
1. **Map each AC to a test** before writing code. Name the test after the behaviour, not the function.
2. **Drive the real path.** Test through the real handler, MCP tool or endpoint the user reaches, not only a helper it calls. A helper-only test once let a job ship disconnected (`delivery-process.md` §3.3).
3. **Fakes must not write what they assert.** If a test double produces the field the test checks, the test proves only the fake. Assert on what the code under test produced.
4. **Use the shapes real users produce**: long inputs, unicode, empty values, the inbound payloads of 06 §9, not only a tidy example.
5. **S2: commit the failing tests first.**
   ```bash
   pnpm --filter <package> test        # red: record the failing test names
   git commit -m "<TASK-ID>: add failing tests for <behaviour>"
   git push                              # the red CI run is the tests-first evidence
   ```
   Then implement in a later commit. Put the red commit SHA and the CI run link in the PR's **Tests-first evidence** section.
6. **Negative control for every new test.** Break the behaviour on purpose (invert a condition, return early, drop the field), run the test and watch it go red, then restore exactly:
   ```bash
   pnpm --filter <package> exec vitest run <test-file>   # must FAIL with the sabotage
   git checkout -- <source-file>                         # restore exactly
   git diff --exit-code -- <source-file>                 # proves nothing is left behind
   pnpm --filter <package> exec vitest run <test-file>   # green again
   ```
   Record each control in the PR under **Tests added**: "control: removed X → test Y failed".
7. **Never weaken** a test, assertion, vector, threshold or lint rule to get green: no `.skip`, `.only`, `--passWithNoTests`, broadened `expect`, lowered coverage. If a test must change, stop and escalate (`development-process.md` §3.3).
8. Run the full set before handing back:
   ```bash
   pnpm lint && pnpm typecheck && pnpm test
   ```

## Verify
- Each AC in the report points to a test name and a command result.
- Each new test has a recorded negative control.
- `git diff origin/main...HEAD -- '*.test.*' | grep -nE '\.skip|\.only|passWithNoTests'` prints nothing.
- S2: the PR shows a red CI run on the tests-only commit, before the implementation commit.

## If it fails
- **A negative control stays green:** the test does not test the behaviour. Rewrite it; do not ship it.
- **A flaky test:** see [RB-08](ci-red.md). Fix it; quarantine needs an issue and the owner's approval (`development-process.md` §10).
- **Tests need the network:** unit tests must not. Use a local fake that does not produce the asserted value, or move the case to e2e.

## Related
- Rules: [`development-process.md`](../process/development-process.md) §10 (testing standards) and §7.2 (S2 commit order); [`delivery-process.md`](../process/delivery-process.md) §3.3; [`audit-rules.md`](../process/audit-rules.md) §3 (tests-first evidence).
- [RB-06 cross-runtime test vectors](test-vectors.md).
