# RB-02 · Claiming a task: board row, branch, worktree

## Purpose
Turn a backlog card into a visible, exclusive claim (a board row naming a pushed branch) with its own branch and worktree, so no two people or agents build the same thing or write in the same checkout.

## When to use
Before any write work on a card. Not for read-only surveys or reviews, which claim nothing.

## Who runs it
The orchestrator (Opus), or a human builder for their own task. Workers never push, open PRs or write the `sync` branch (`development-process.md` §4.2); the orchestrator claims on their behalf and hands them the worktree path in the brief.

## Preconditions
- The card exists in `docs/process/backlog.md` and meets the Definition of Ready (`development-process.md` §6.2). No task ID, no work.
- [RB-01](session-start-end.md) start steps done: nobody else holds the task on `board.md` or on a pushed branch. If someone does, stop and write an ask instead.
- You know the card's security class (`audit-rules.md` §2: path defaults plus content rules, the highest wins).

## Steps
1. Find the card and read it:
   ```bash
   grep -n '^#### <TASK-ID> ' docs/process/backlog.md
   ```
2. Create the branch and its worktree from current `main` (one task = one worktree = one PR):
   ```bash
   git fetch origin
   git worktree add ../agentlink-<TASK-ID> -b <TASK-ID>-<slug> origin/main
   ```
   The slug is lowercase kebab-case (`M1-5a-gift-wrap-size-check`). In Claude Code, a worker started with `isolation: "worktree"` gets its own worktree; still name the branch after the task.
3. Make the first commit so the branch can be pushed (CI runs on the push). Never `git stash` (the stash stack is shared by every worktree); use a work-in-progress commit:
   ```bash
   git -C ../agentlink-<TASK-ID> commit --allow-empty -m "<TASK-ID>: start"
   git -C ../agentlink-<TASK-ID> push -u origin <TASK-ID>-<slug>
   ```
4. Add your row to `board.md` → Active tasks (`<TASK-ID> | @<login> | in-progress | <branch> | <UTC time>`), then commit and push the `sync` worktree as in [RB-01](session-start-end.md) step 10.
5. **Open no PR yet.** The PR is opened only after the independent review passes ([RB-04](independent-review.md)), not (draft) at claim time: failed runs on PRs e-mail the owner, and a PR whose review is pending only makes `review-gate` red (lesson [LL-13](../lessons/LL-13-open-prs-after-review.md)). When it opens, the title must start with the task ID or an allowed prefix (lesson [LL-02](../lessons/LL-02-pr-title-prefix.md)); add ` / #<n>` to your board row.

## Verify
- `git ls-remote --heads origin <branch>` lists the pushed branch, and `gh run list --branch <branch>` shows a CI run on the push.
- `git -C ../agentlink-sync log -1 --oneline` shows your claim commit, and `git -C ../agentlink-sync status -sb` is in sync with `origin/sync`.
- `git worktree list` shows the new worktree on the task branch.

## If it fails
- **Someone claimed it at the same time:** the earlier board row wins. Delete your branch (`git push origin --delete <branch>`), remove your row, remove the worktree (`git worktree remove ../agentlink-<TASK-ID>`).
- **CI red on the first push:** expected for tests-first S2 work (that is the evidence); otherwise [RB-08](ci-red.md).
- **Releasing a claim:** only the claimant or the owner releases it; remove the row and delete the branch, or close or hand over the PR if one is open.

## Related
- Rules: [`sync-protocol.md`](../process/sync-protocol.md) §5–§6, [`development-process.md`](../process/development-process.md) §6 and §7, [`delivery-process.md`](../process/delivery-process.md) §3.1 (isolation).
- Next: [RB-03 worker brief](worker-brief.md).
