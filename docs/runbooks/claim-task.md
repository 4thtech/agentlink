# RB-02 · Claiming a task: branch, worktree, draft PR

## Purpose
Turn a backlog card into a visible, exclusive claim (a board row plus a draft PR) with its own branch and worktree, so no two people or agents build the same thing or write in the same checkout.

## When to use
Before any write work on a card. Not for read-only surveys or reviews, which claim nothing.

## Who runs it
The orchestrator (Opus), or a human builder for their own task. Workers never push, open PRs or write the `sync` branch (`development-process.md` §4.2); the orchestrator claims on their behalf and hands them the worktree path in the brief.

## Preconditions
- The card exists in `docs/process/backlog.md` and meets the Definition of Ready (`development-process.md` §6.2). No task ID, no work.
- [RB-01](session-start-end.md) start steps done: nobody else holds the task on `board.md` or as a draft PR. If someone does, stop and write an ask instead.
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
3. Make the first commit so a PR can exist. Never `git stash` (the stash stack is shared by every worktree); use a work-in-progress commit:
   ```bash
   git -C ../agentlink-<TASK-ID> commit --allow-empty -m "<TASK-ID>: start"
   git -C ../agentlink-<TASK-ID> push -u origin <TASK-ID>-<slug>
   ```
4. Open the draft PR with the template filled as far as you can (every section needs text; write "N/A" or "TBD" where nothing is known yet):
   ```bash
   cp .github/pull_request_template.md <scratch>/rb-<TASK-ID>-body.md   # then edit it
   gh pr create --draft --title "<TASK-ID> <summary>" --body-file <scratch>/rb-<TASK-ID>-body.md
   ```
   The title must start with the task ID or an allowed prefix (lesson [LL-02](../lessons/LL-02-pr-title-prefix.md)).
5. Add your row to `board.md` → Active tasks (`<TASK-ID> | @<login> | in-progress | <branch> / #<n> | <UTC time>`), then commit and push the `sync` worktree as in [RB-01](session-start-end.md) step 10.

## Verify
- `gh pr view <n> --json isDraft,title,headRefName` shows `isDraft: true` and the task ID in title and branch.
- `git -C ../agentlink-sync log -1 --oneline` shows your claim commit, and `git -C ../agentlink-sync status -sb` is in sync with `origin/sync`.
- `git worktree list` shows the new worktree on the task branch.

## If it fails
- **Someone claimed it at the same time:** the earlier board row plus draft PR wins. Close your draft PR (`gh pr close <n> --delete-branch`), remove your row, remove the worktree (`git worktree remove ../agentlink-<TASK-ID>`).
- **`pr-hygiene` red on the draft:** expected while sections are empty; fill them before marking the PR ready ([RB-08](ci-red.md)).
- **Releasing a claim:** only the claimant or the owner releases it; remove the row and close or hand over the PR.

## Related
- Rules: [`sync-protocol.md`](../process/sync-protocol.md) §5–§6, [`development-process.md`](../process/development-process.md) §6 and §7, [`delivery-process.md`](../process/delivery-process.md) §3.1 (isolation).
- Next: [RB-03 worker brief](worker-brief.md).
