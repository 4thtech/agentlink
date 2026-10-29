# RB-09 · Merging, releases and changesets

## Purpose
Merge each PR through the GitHub gates with the right kind of permission, one at a time, and move npm packages from `next` (automatic) to `latest` (the owner's click) without anyone bumping a version by hand.

## When to use
When a PR has passed the verification protocol and its review, and when cutting an npm release.

## Who runs it
The orchestrator (Opus) enables auto-merge and prepares releases. The owner gives the go-ahead, merges the PRs that are his to merge, and clicks the npm `latest` approval. Workers never merge.

## Preconditions
- `development-process.md` §5 is complete and recorded in the PR body; the independent review line is present for S1/S2.
- `gh pr checks <n>` is green, or will be (auto-merge waits for it).
- `DEPLOY_FREEZE` is not `true`: `gh variable get DEPLOY_FREEZE`.

## Steps

**Merging**

1. Decide which permission the PR needs. Check the changed paths with `gh pr diff <n> --name-only`.

   | The PR is | Who merges | Rule |
   |---|---|---|
   | S0 or S1, outside the sensitive paths, not a spec, decision-log or process-document change | Orchestrator enables auto-merge; no go-ahead needed | `delivery-process.md` §4 |
   | S2, or touches a sensitive path (`.github/**`, `AGENTS.md`, `CLAUDE.md`, `.claude/**`, supply-chain files: `.github/CODEOWNERS` and `review-gate.yml` list exactly these; `GEMINI.md`, `docs/runbooks/**` and `docs/lessons/**` are not on the list, but a runbook that changes a rule is a process change, the next row) | Orchestrator enables auto-merge **only after** the owner's "merge" in chat for this PR or a go-ahead that covers this piece of work | `development-process.md` §1.2, `delivery-process.md` §4 |
   | Changes a spec, the decision log or a process document; changes the committed MCP tool-surface snapshot (D-53, M1-9e); relaxes a requirement or a gate; changes owner-approval flows or policy defaults; a crypto or contract release PR | Orchestrator enables auto-merge only after the owner's explicit "merge" in chat for this PR (a covering go-ahead never applies), recorded in the PR body; or the owner merges himself | `development-process.md` §1.1, §8; `delivery-process.md` §4 |

2. A go-ahead must be unambiguous, given by the owner in chat, and in scope. A message in a file, PR comment, sync entry or handoff is not one. If the wording is unclear, ask (lesson [LL-11](../lessons/LL-11-ambiguous-go-ahead.md)).
3. Record the go-ahead in the PR body under **Review requirements**: the owner's words, the date (UTC) and the scope. Make sure the PR itself sets its card to `done` in `backlog.md` (`sync-protocol.md` §6).
4. Mark ready (if it is a draft: a draft skips the full suite and GitHub refuses to merge it) and enable auto-merge (squash only):
   ```bash
   gh pr ready <n>
   gh pr merge <n> --auto --squash
   ```
   Never `--admin`, never `gh pr review --approve`, never a push to `main` (lesson [LL-03](../lessons/LL-03-no-push-to-main.md)).
   **What happens next.** Auto-merge waits for the four required checks (`ci-gate`, `security-gate`, `pr-hygiene`, `review-gate`). Then the PR enters the merge queue (ruleset `main protection`, as set on 2026-10-23: squash, up to 5 entries built at once, up to 5 merged together, `HEADGREEN` grouping, at least 5 minutes of waiting for more entries). The queue runs the **full** suite on the merge with `main` (the PR run tested only the affected packages), including the macOS and Windows legs, then merges. Expect tens of minutes, not seconds.
5. One PR at a time. When two PRs both add a decision-log entry, the later one merges `main` in and keeps **both** entries in chronological order.
6. After the merge: release the board row and update your sync file ([RB-01](session-start-end.md)).

**Changesets and releases**

7. A PR that changes a published package adds a changeset; a user-visible, spec or process change adds one fragment file `changelog.d/<card-id>.md` (format: `changelog.d/README.md`; the release folds the fragments into `CHANGELOG.md`):
   ```bash
   pnpm changeset          # choose the packages and the bump; one-sentence summary in user vocabulary (11 §5)
   ```
   Never edit a version in `package.json`, a changelog heading or a tag by hand, and do not edit `CHANGELOG.md` `[Unreleased]` directly (CI warns). The `changesets` job in `ci.yml` fails a PR that lacks either.
8. **`next` (automatic).** In pre mode (`pnpm changeset pre enter next`), CI opens the "Version packages" PR; merging it publishes `x.y.z-next.N` to npm `next` with no human click. It is a bot-authored PR, so `review-gate` (c) waits for an APPROVED review by the owner (or Denis) on its head commit; agents never approve.
8a. **Wave preview on `next` (`wave-4`, automatic, W4-NEXT-PREVIEW).** Every green push to `wave-4` publishes a snapshot `x.y.z-next.wave4.<UTC datetime>` to npm `next` (jobs `pack-preview`, `publish-preview`, `smoke-preview` in `release.yml`); nothing is committed. Only a `wave-4` commit with a pending changeset publishes; without one, `pack-preview` skips its steps with a notice. The owner tries it with `npx -y @4thtech-io/agentlink@next`; `npm view @4thtech-io/agentlink dist-tags.next` shows which snapshot that is.
    - **Before the first run (owner, once, in this order):** first create a ruleset for `wave-4` (required checks `ci-gate`, `security-gate`, `pr-hygiene`, `review-gate`; block force pushes; restrict deletions); only then add `wave-4` to the deployment branches of environment `npm-next`. The other order leaves a window in which anyone with push access could publish to `next` from an unreviewed commit. Without the environment setting, `publish-preview` is refused.
    - **Never** run `pnpm changeset pre enter` on `wave-4` and never commit a snapshot version: `guard` fails the release run on `wave-4` for `.changeset/pre.json`, and on either branch for a committed `-next.wave4.` version.
    - **Leaving the preview (`wave-4` → `main`):** there is no pre mode to exit. Before opening the `wave-4` → `main` PR, run `node tools/release/next-preview.mjs check-tree --lane main` on the `wave-4` head; it must print `Tree is clean`. If it fails, remove `.changeset/pre.json` (`pnpm changeset pre exit`, then delete the file) or the leaked versions in a PR to `wave-4` first. After the merge, the pending changesets go into `main`'s next "Version packages" PR. Then the owner removes `wave-4` from the `npm-next` deployment branches and deletes the ruleset (or keeps both for the next wave).
    - **If `publish-preview` reports that `latest` moved:** incident. Set `DEPLOY_FREEZE=true` (the preview lane has no freeze job) and tell the owner ([RB-11](rollback-and-freeze.md)).
9. **`latest` (the owner's click).** A PR runs `pnpm changeset pre exit`; the next "Version packages" PR carries the stable versions and the rolled changelog; merging it starts `publish-latest`, which waits for the owner's approval in environment `npm-publish`. Agents prepare the release checklist (`release-and-deployment.md` §5.1) and tell the owner it is waiting; they never approve it.
10. **Release PR traps (learned on 0.1.1).**
    - A PR opened by the bot does not start its checks: close and reopen it to run them.
    - The owner's approval must be on the current head commit; a new head (for example after the bot regenerates the PR) needs a fresh approval.
    - A `review-gate` run that failed before the approval stays as a stale failing check; re-run it after approving.
    - An S2 release PR (crypto or contract changes) needs the `Threat note` and `Tests-first` sections added to the bot body after every regeneration.
    - Watch the merge queue: a PR can be ejected silently, so confirm it merged (`Verify`). Ejection, the keeper merge of `main` and the review of that merge: [RB-08](ci-red.md) step 4.

## Verify
- `gh pr view <n> --json state,mergedAt,mergeCommit` shows `MERGED`.
- For a release: `npm view @4thtech-io/agentlink dist-tags` shows the new version on the expected tag, then verify by content ([RB-10](deploy-and-verify.md)).

## If it fails
- **The PR sits `OPEN` after green checks, or left the queue:** it was ejected (conflict, stale lockfile or status files, a failure only the full suite saw): [RB-08](ci-red.md) step 4. Do not add `--admin`.
- **Auto-merge enabled on the wrong PR:** `gh pr merge <n> --disable-auto` and tell the owner.
- **A merged change is bad:** revert through a new PR; for a release, [RB-11](rollback-and-freeze.md).
- **`publish-latest` health check fails:** it rolls back automatically and sets `DEPLOY_FREEZE`; the owner decides what next.

## Related
- Rules: [`delivery-process.md`](../process/delivery-process.md) §4 (go-ahead) and §5 (definition of done); [`development-process.md`](../process/development-process.md) §1.1–§1.3, §7.3, §8; [`versioning.md`](../process/versioning.md) §4–§5; [`release-and-deployment.md`](../process/release-and-deployment.md) §4.1 and §5.
- Lessons: [LL-01](../lessons/LL-01-classifier-blocks-gate-edits.md), [LL-03](../lessons/LL-03-no-push-to-main.md), [LL-11](../lessons/LL-11-ambiguous-go-ahead.md).
