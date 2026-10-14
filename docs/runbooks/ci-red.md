# RB-08 · CI is red

## Purpose
Find which required check failed and why, fix the cause in your own change, and never make a check green by weakening it.

## When to use
Any red or cancelled required check on a PR: `ci-gate`, `security-gate`, `pr-hygiene`, `review-gate` (contracts repository: `contracts-gate`). Red on `main` after a merge is an incident: go to [RB-11](rollback-and-freeze.md).

## Who runs it
The orchestrator, or the builder that owns the change (Sonnet or above). The fix goes to whoever owns the failing files. Nobody edits `.github/**` to get green; that is an owner "merge" change of its own.

## Preconditions
- The PR exists and CI has finished: `gh pr checks <n> --watch` has returned.

## Steps
1. See what failed and read only the failing log:
   ```bash
   gh pr checks <n>
   gh run view <run-id> --log-failed > <scratch>/rb-ci-<n>.log
   grep -n -iE 'error|fail' <scratch>/rb-ci-<n>.log | head -40
   ```
   `ci-gate` and `security-gate` are aggregators: the real failure is in an upstream job.
2. Triage by check:

   | Check | Upstream jobs | Typical cause | Fix |
   |---|---|---|---|
   | `ci-gate` | `detect` | `package.json` without `"packageManager": "pnpm@x.y.z"`, or in strict mode a missing root script | Add the pin or the script; never delete `.github/ci-strict` |
   | `ci-gate` | `checks` | lint, typecheck, build or test failure | Reproduce locally: `pnpm lint && pnpm typecheck && pnpm build && pnpm test` |
   | `ci-gate` | `vectors` | vector mismatch, or "playwright not found" | Vector mismatch: [RB-06](test-vectors.md). Playwright: lesson [LL-07](../lessons/LL-07-playwright-lockfile-heuristic.md) |
   | `ci-gate` | `context-budget` | `AGENTS.md` > 8192 bytes or `CLAUDE.md` > 1024 bytes | `wc -c AGENTS.md CLAUDE.md`; move detail into `docs/` and leave a pointer. Check that no tool rewrote `AGENTS.md` (lesson [LL-04](../lessons/LL-04-turbo-agent-guidance.md)) |
   | `security-gate` | `dependency-review` | a vulnerable or disallowed-licence dependency | Another version or package ([RB-07](add-dependency.md)) |
   | `security-gate` | `secret-scan` | gitleaks found a secret | **Stop the line** (`audit-rules.md` §10.3): tell the owner at once. Do not push more commits or rewrite history on your own; the secret is already public and must be rotated |
   | `security-gate` | `codeql`, `zizmor` | code or workflow finding | Fix the code. A workflow finding is a `.github` change for the owner's "merge" |
   | `pr-hygiene` | — | title prefix; an empty template section; not exactly one class ticked | `gh pr edit <n> --title "<TASK-ID> <summary>"` or `--body-file <file>`; lesson [LL-02](../lessons/LL-02-pr-title-prefix.md) |
   | `review-gate` | — | ticked class lower than the derived one; no `IR-<TASK-ID>-<k>`; a FAIL verdict; S2 sections empty; `DEPLOY_FREEZE` is `true` | Tick the derived class; run the review ([RB-04](independent-review.md)); fill the sections. Freeze: wait for the owner |

3. **Flaky or unrelated failure:** re-run the failed jobs once:
   ```bash
   gh run rerun <run-id> --failed
   ```
   If it passes, write "flake: <test>, run <id>" in the PR and open a fix card for it (`delivery-process.md` §2, step 8). If it fails again, it is not a flake: investigate. Flaky tests are fixed, not quarantined, unless the owner approves a quarantine with an issue (`development-process.md` §10).
4. Push the fix as a new commit (do not rewrite history after review started) and wait for CI again.

## Verify
`gh pr checks <n>` shows all four required checks as `pass`. A skipped job is not evidence for an acceptance criterion (`development-process.md` §6.3).

## If it fails
- **You cannot fix it inside your owned files:** report `STATUS: escalate` (worker) or ask the owner (orchestrator). Never `.skip` a test, lower a threshold, add a gitleaks allowlist entry or edit a workflow to get green.
- **`review-gate` red only because the review is pending:** expected; it turns green when the IR line is added.
- **The check itself looks wrong:** describe it in the PR's Open questions and open a CI card; the owner decides.

## Related
- Rules: [`ci-cd.md`](../process/ci-cd.md) (workflows, required checks, skeleton tolerance, strict mode); [`audit-rules.md`](../process/audit-rules.md) §3.3 and §10; [`development-process.md`](../process/development-process.md) §10.
- Lessons: [LL-02](../lessons/LL-02-pr-title-prefix.md), [LL-04](../lessons/LL-04-turbo-agent-guidance.md), [LL-07](../lessons/LL-07-playwright-lockfile-heuristic.md).
