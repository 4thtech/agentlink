# RB-08 · CI is red

## Purpose
Find which required check failed and why, fix the cause in your own change, and never make a check green by weakening it.

## When to use
Any red or cancelled required check on a PR or in the merge queue: `ci-gate`, `security-gate`, `pr-hygiene`, `review-gate` (contracts repository: `contracts-gate`). A PR ejected from the merge queue (step 4). Red on `main` after a merge is an incident: go to [RB-11](rollback-and-freeze.md).

## Who runs it
The orchestrator, or the builder that owns the change (Sonnet or above). The fix goes to whoever owns the failing files. Nobody edits `.github/**` to get green; that is an owner "merge" change of its own.

## Preconditions
- The PR exists and CI has finished: `gh pr checks <n> --watch` has returned.
- Know which run you are looking at (`ci.yml` and `security.yml` run per event, `ci-cd.md` "What runs where"):
  - **A draft PR** skips the whole suite; `ci-gate` and `security-gate` go green with every job skipped. That green says nothing about your code. Marking the PR ready (`ready_for_review`) starts the full suite, so red can first appear then.
  - **A PR (not draft)** lints, typechecks, builds and tests only the packages the change touches, their dependents and `@4thtech-io/tools` (`tools/ci/select-affected.mjs`). A change under `.github/`, `tools/`, root config, the lockfile, `test-vectors/` or `packages/types`, `crypto`, `core` runs everything. The macOS and Windows legs do not run on a PR.
  - **A branch push** (`ci-gate (push)`, not required) runs the full suite on the Ubuntu legs. It is the pre-review test; it is not the check that merges.
  - **The merge queue** (`merge_group`) always runs the full suite on the merge of your PR with `main`, including macOS and Windows. A failure that only the queue sees is usually a package your change affects that the selector did not name, a platform leg, or a flake.

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
   | `ci-gate` | `stale-precheck` (PR only) | merge conflict with the current `main`; generated status files out of date on the merged tree; `pnpm-lock.yaml` no longer installs frozen on the merged tree | Merge, never rebase: `git fetch origin && git merge origin/main`. Status files (`README.md`, `docs-site/technical/project/status-and-roadmap.md`, `knowledge/agentlink-overview.md`): `git checkout origin/main -- <those three> && node tools/docs-status/index.mjs`. Lockfile: `git checkout origin/main -- pnpm-lock.yaml && pnpm install --ignore-scripts --ignore-pnpmfile`. The job log prints the same commands |
   | `ci-gate` | `changesets` (PR only) | a published package changed without a changeset, or a user-visible, spec or process change without a `changelog.d/<card-id>.md` fragment | `pnpm changeset` (an empty one for a test-only change); add the fragment (`changelog.d/README.md`). Never edit `CHANGELOG.md` `[Unreleased]` |
   | `ci-gate` | `checks` | lint, typecheck, build or test failure | Reproduce the packages you touched and their dependents: `pnpm --filter '...<package>' test`; the whole set is `pnpm lint && pnpm typecheck && pnpm build && pnpm test` |
   | `ci-gate` | `vectors` | vector mismatch, or "playwright not found" | Vector mismatch: [RB-06](test-vectors.md). Playwright: lesson [LL-07](../lessons/LL-07-playwright-lockfile-heuristic.md); the install step caches the browsers, retries a failed download once and bounds apt, so a `::warning::` that it retried is not a failure |
   | `ci-gate` | `e2e-deterministic`, `relays-docker`, `storage-minio`, `bundle-check` (code changes only; docs-only PRs skip them) | an end-to-end, relay, S3 or bundle-size failure | Read the failing step; `e2e` logs `::error::runner keychain unavailable` when the throwaway keyring died (infrastructure, a rerun candidate) |
   | `ci-gate` | `keychain`, `path-guard`, `node-os` (merge queue and `main` only) | an OS-specific failure on macOS or Windows that a PR run never executes | Reproduce on that OS, or read the queue log; fix on your branch |
   | `ci-gate` | `context-budget` | `AGENTS.md` > 8192 bytes or `CLAUDE.md` > 1024 bytes | `wc -c AGENTS.md CLAUDE.md`; move detail into `docs/` and leave a pointer. Check that no tool rewrote `AGENTS.md` (lesson [LL-04](../lessons/LL-04-turbo-agent-guidance.md)) |
   | `security-gate` | `dependency-review` (not run on a draft or in the queue) | a vulnerable or disallowed-licence dependency | Another version or package ([RB-07](add-dependency.md)) |
   | `security-gate` | `secret-scan` | gitleaks found a secret | **Stop the line** (`audit-rules.md` §10.3): tell the owner at once. Do not push more commits or rewrite history on your own; the secret is already public and must be rotated |
   | `security-gate` | `codeql` (not run on a draft or in the queue), `zizmor` | code or workflow finding | Fix the code. A workflow finding is a `.github` change for the owner's "merge" |
   | `pr-hygiene` | — | title prefix; an empty template section; not exactly one class ticked | `gh pr edit <n> --title "<TASK-ID> <summary>"` or `--body-file <file>`; lesson [LL-02](../lessons/LL-02-pr-title-prefix.md) |
   | `review-gate` | — | ticked class lower than the derived one; no `IR-<TASK-ID>-<k>`; a FAIL verdict; S2 sections empty; `DEPLOY_FREEZE` is `true` | Tick the derived class; run the review ([RB-04](independent-review.md)); fill the sections. Bot PR (Renovate, "Version packages"): it waits for the owner's GitHub approval on the head commit; agents never approve. Freeze: wait for the owner |

3. **Flake or real failure?** Decide from the log before you rerun anything.
   - Looks like a flake (infrastructure or timing): a step that hit its `timeout-minutes` or `timeout`; an apt, CDN or registry download error; `Playwright ... failed once; retrying`; `runner keychain unavailable`; "The runner has received a shutdown signal"; a job in an area your diff does not touch that passes on the previous commit.
   - Looks real: the assertion names code or a file your change touches; it fails the same way when you reproduce it locally; it fails on the merge-queue run as well as the PR run; a lint, type, build, `stale-precheck`, `changesets`, `pr-hygiene` or `review-gate` failure (those are deterministic, never reruns).
   - **Rerun policy.** Re-run the failed jobs, not the whole run, at most once, and only for a suspected flake:
     ```bash
     gh run rerun <run-id> --failed
     ```
     If it passes, write "flake: <test>, run <id>" in the PR and open a fix card for it (`delivery-process.md` §2, step 8). If it fails again, it is not a flake: investigate. Never rerun in a loop: reruns spend the shared runner pool (lesson [LL-17](../lessons/LL-17-ci-starvation-stale-pr-ejections.md)). Flaky tests are fixed at the cause, not quarantined, unless the owner approves a quarantine with an issue (`development-process.md` §10). A PR whose checks look stuck: `gh pr checks <n>`, then `gh run list --branch <branch> --limit 5`; do not push empty commits to wake it.
   - *Coming (CHORE-CI-AUTORETRY, in review):* CI will retry a failed job once by itself. Until that merges, the manual single rerun above is the policy; after it merges, a red check has already been retried once, so treat it as real and do not rerun it again.
4. **Ejected from the merge queue.** A PR that enters the queue is tested as the merge with `main` (and with the queued PRs ahead of it) and runs the full suite. If that fails, the queue removes the PR and it stays open.
   ```bash
   gh pr view <n> --json state,autoMergeRequest,mergeStateStatus
   gh run list --workflow ci.yml --event merge_group --limit 20 --json databaseId,headBranch,conclusion
   ```
   `state` still `OPEN` after the checks were green means it was ejected. The queue's branches are named `gh-readonly-queue/main/pr-<n>-<sha>`; take the run whose branch holds `pr-<n>-` and read it with `gh run view <run-id> --log-failed`. Then:
   1. **Conflict or stale tree:** the keeper (the orchestrator, or the owner of the branch) merges `origin/main` into the PR branch (never rebase, never force-push) and applies the `stale-precheck` fixes from step 2: status files regenerated, lockfile reinstalled. Do not "take ours" blindly: check that the PR's own files are all still in the diff against `origin/main` and that no conflict markers remain.
   2. **A real failure that only the queue saw** (a platform leg, a package outside the PR's selection): fix it on the branch like step 2.
   3. **A flake in the queue run:** one rerun of the failed jobs is allowed by step 3's policy; if the run cannot be rerun any more, push the fix or the merge commit and re-enqueue.
   4. **Review after the merge.** The head moved, so the merge commit is a change the independent review did not see. For S1/S2, a delta review with the next number covers it ([RB-04](independent-review.md) step 4; the reviewer reads the delta between the old and new head and the merge commit's re-merge diff, and checks that nothing of the PR was dropped). *Coming (PROC-MECH-MERGE-IR, D-126, in review):* a lighter re-verification for a purely mechanical merge of `main`. Until it merges, use the delta review.
   5. Re-enqueue and confirm it merged (`gh pr view <n> --json state,mergedAt`):
      ```bash
      gh pr merge <n> --auto --squash
      ```
      Only for a PR that was cleared to merge ([RB-09](merge-and-release.md)); never an admin merge.
5. Push the fix as a new commit (do not rewrite history after review started) and wait for CI again. A push cancels the PR's older run; that is normal.

## Verify
`gh pr checks <n>` shows all four required checks as `pass` on a non-draft PR (on a draft they are green with the suite skipped: mark it ready and look again). A skipped job is not evidence for an acceptance criterion (`development-process.md` §6.3).

## If it fails
- **You cannot fix it inside your owned files:** report `STATUS: escalate` (worker) or ask the owner (orchestrator). Never `.skip` a test, lower a threshold, add a gitleaks allowlist entry or edit a workflow to get green.
- **`review-gate` red only because the review is pending:** expected; it turns green when the IR line is added.
- **The check itself looks wrong:** describe it in the PR's Open questions and open a CI card; the owner decides. Where to look first: `gh pr checks <n>`, the run summary (`gh run view <run-id>`), then `--log-failed`.

## Related
- Rules: [`ci-cd.md`](../process/ci-cd.md) (workflows, required checks, what runs where, drafts and the stale-PR precheck, skeleton tolerance, strict mode); [`audit-rules.md`](../process/audit-rules.md) §3.3 and §10; [`development-process.md`](../process/development-process.md) §10.
- Lessons: [LL-02](../lessons/LL-02-pr-title-prefix.md), [LL-04](../lessons/LL-04-turbo-agent-guidance.md), [LL-07](../lessons/LL-07-playwright-lockfile-heuristic.md), [LL-17](../lessons/LL-17-ci-starvation-stale-pr-ejections.md).
- A deploy workflow that did not run or did not deploy: [RB-10](deploy-and-verify.md), "If it fails".
