# RB-14 · When a permission or safety check denies an action

## Purpose
Handle a refusal from the harness (a deny rule, a permission prompt declined, a safety classifier) or from GitHub (a ruleset, an environment, a required check) the only safe way: stop, explain, and let the owner decide.

## When to use
Any time an action you tried is blocked by something other than a plain bug: a `.claude/settings.json` deny rule, a refused permission, a safety-classifier refusal, a ruleset or environment rejection, a worktree-isolation refusal.

## Who runs it
Every agent, at every tier. A worker reports it to the orchestrator; the orchestrator reports it to the owner.

## Preconditions
None.

## Steps
1. **Stop that line of work.** A denial is final for you (`delivery-process.md` §3.2).
2. **Do not route around it.** Not in smaller pieces, not with another tool, not through a subagent, not with a raw API call or a different flag, not by editing the rule that blocked you. Each of those is the same action.
3. Write down exactly what happened: the command or action, the denial text quoted, and what you were trying to achieve.
4. Tell the owner (worker: report `STATUS: blocked` with those three items):
   - why the action seemed necessary;
   - the options you see, including "do not do it";
   - which option, if any, only the owner can perform (`development-process.md` §1.1).
5. Wait. The owner decides: he does it himself, changes the rule himself, or drops it. Agents never relax the thing that blocked them (a deny rule in `.claude/settings.json`, a ruleset, an environment, gate logic in `.github/`); changing rulesets and environments is owner-only (`development-process.md` §1.1), and gate edits are made by the owner himself (lesson [LL-01](../lessons/LL-01-classifier-blocks-gate-edits.md)).
6. If the denial taught something new, propose a lesson ([`../lessons/`](../lessons/README.md)) in a later PR.

## Verify
- The blocked action was not performed by any route.
- The owner's decision is in the conversation and, if it changes state, in your sync file or the Curator handoff.

## If it fails
- **You realise you already worked around a denial:** stop, tell the owner exactly what was done, and treat it as a stop-the-line event if it touched approvals, deployments, secrets or `main` (`audit-rules.md` §10.1).

## Related
- Rules: [`delivery-process.md`](../process/delivery-process.md) §3.2 (permission layer); [`development-process.md`](../process/development-process.md) §1.2; [`release-and-deployment.md`](../process/release-and-deployment.md) §10 (recommended deny rules).
- Lessons: [LL-01](../lessons/LL-01-classifier-blocks-gate-edits.md), [LL-03](../lessons/LL-03-no-push-to-main.md), [LL-11](../lessons/LL-11-ambiguous-go-ahead.md).
