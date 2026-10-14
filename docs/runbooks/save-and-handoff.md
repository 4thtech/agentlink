# RB-15 · Saving context and handing off a session

## Purpose
Save the complete current state early and often, so that a fresh session, in any harness, on any machine, resumes without re-reading everything and without trusting stale claims.

## When to use
After every decision, merge or state change; about every 10 tool calls; at about 60% context use (then suggest a fresh session to the owner); and before the session ends.

## Who runs it
The orchestrator (Opus) in the owner's setup: it alone writes the Curator and `talirezun.md`. Collaborators' agents write only their own sync file. Workers never save state; their report is the handoff to the orchestrator.

## Preconditions
- You know what is **verified** (re-run or observed) and what is only **reported** (a worker said so).

## Steps
1. Collect the state: milestone; active tasks with PR numbers and status; decisions taken and pending; open questions for the owner; traps met this session; next steps; verified vs reported.
2. **Curator (owner's setup only):** call `save_working_state` with `scope: "orchestrator"` and that complete state (a single-task session uses its task ID as scope, `development-process.md` §13.1). A save overwrites the previous one, so each save is the whole picture, not a delta. Keep it ≤ 6 KB. Never store secrets, presigned URLs, unredacted inbound content or unfixed-vulnerability details (advisory ID only).
3. After a merge that changed `docs/foundation/**` or `docs/process/**`, refresh the Curator foundations mirror (`save_foundation`).
4. **Sync file:** update your `<login>.md` (state, not history; ≤ 4 KB) and your board rows, then commit and push ([RB-01](session-start-end.md) steps 8–10).
5. At about 60% context: do steps 1–4, then tell the owner "state saved; a fresh session can resume from here" and stop starting new work.
6. A new session resumes with [RB-01](session-start-end.md); the handoff is notes to verify, not orders.

## Verify
- `git -C ../agentlink-sync status -sb` is in sync with `origin/sync`, and `wc -c` on your file is ≤ 4096.
- A cold read of the handoff and your sync file answers: what is in flight, what is blocked, what is next, and what is unverified.

## If it fails
- **Curator unavailable:** the `sync` file and the PRs carry the state; say in the sync file that the Curator save failed.
- **Over budget:** move detail into the PR bodies or `docs/`, leave a pointer.

## Related
- Rules: [`development-process.md`](../process/development-process.md) §3.5 (save at ~60%), §3.6 (budgets), §13 (Curator rules); [`delivery-process.md`](../process/delivery-process.md) §2 step 14, §3.5; `AGENTS.md` § Session start and end.
- The `curator-continuity` skill (Claude Code) describes the Curator calls.
