# Runbooks

A runbook is the **how** for one repeatable procedure: numbered steps with exact commands. The **rules** live in [`../process/`](../process/development-process.md); a runbook links to them and never restates or changes them. If a runbook and a process document disagree, the process document wins and the runbook is fixed in the same PR. A procedure that would change what is allowed is a process change first (`development-process.md` §8).

Private procedures (incident response, secret rotation, deploy keys, Safe operations, mainnet deployment, filing review reports) live in the private repository `4thtech/agentlink-ops` under `runbooks/`.

## Index

| ID | Runbook | Who runs it | Tier |
|---|---|---|---|
| RB-01 | [Session start and end, any harness](session-start-end.md) | Any agent or person | Any |
| RB-02 | [Claiming a task: board row, branch, worktree](claim-task.md) | Orchestrator, or a human builder | Opus (orchestrator) |
| RB-03 | [Writing a worker brief](worker-brief.md) | Orchestrator | Opus |
| RB-04 | [Running an independent review](independent-review.md) | Orchestrator spawns, reviewer runs | Opus |
| RB-05 | [Writing tests](writing-tests.md) | Builder | Per the card |
| RB-06 | [Cross-runtime test vectors](test-vectors.md) *(placeholder until M0-9)* | Builder | Opus (S2) |
| RB-07 | [Adding a dependency](add-dependency.md) | Builder proposes, orchestrator checks | Sonnet or above |
| RB-08 | [CI is red](ci-red.md) | Orchestrator or builder | Sonnet or above |
| RB-09 | [Merging, releases and changesets](merge-and-release.md) | Orchestrator; owner for his steps | Opus |
| RB-10 | [Deploying and verifying by content](deploy-and-verify.md) | CI deploys, orchestrator verifies | Opus |
| RB-11 | [Rollback and `DEPLOY_FREEZE`](rollback-and-freeze.md) | Any agent on a documented trigger sets the freeze; owner clears it | Opus |
| RB-12 | [Design drop intake](design-drop-intake.md) | Orchestrator | Opus plans, Sonnet builds |
| RB-13 | [Relaying Denis's feedback](relay-feedback.md) | Orchestrator | Opus |
| RB-14 | [When a permission or safety check denies an action](permission-denied.md) | Any agent | Any |
| RB-15 | [Saving context and handing off a session](save-and-handoff.md) | Orchestrator | Opus |

## Template

Every runbook uses exactly these sections, in this order. Write "None" where a section does not apply.

```markdown
# RB-<nn> · <Title>

## Purpose
One or two sentences: the outcome.

## When to use
The trigger. Also when *not* to use it.

## Who runs it
Role and model tier (`development-process.md` §3.1). Who must never run it.

## Preconditions
What must be true before step 1.

## Steps
1. Numbered steps with exact commands in fenced blocks. Placeholders in <angle brackets>.

## Verify
How to prove it worked: a command and its expected output, not "looks fine".

## If it fails
Rollback, or what to do and whom to tell.

## Related
Process documents (the rules), other runbooks, lessons.
```

## Conventions

- **Commands** assume the repository root as working directory, `zsh` or `bash`, and the `gh` CLI logged in. Quote any argument that contains `?`, `*` or `[` (lesson [LL-10](../lessons/LL-10-zsh-glob-in-gh-api.md)).
- **Placeholders**: `<TASK-ID>` (a backlog card, for example `M1-5a`), `<n>` (PR number), `<login>` (`gh api user --jq .login`).
- **Scratch files** go to your session's scratch directory with a unique prefix, never a shared fixed name (lesson [LL-09](../lessons/LL-09-shared-scratch-files.md)).
- **Agents never** approve, merge with admin bypass, push to `main`, deploy from a workstation or clear `DEPLOY_FREEZE`. No runbook asks them to.
- **Adding a runbook**: copy the template, take the next `RB-` number, add a row to the index, and link it from the process document it serves.
