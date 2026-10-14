# LL-03 · Never push to `main`; always branch plus PR

**Problem.** Landing a small change directly on `main` looks quicker than a branch and a PR.

**Symptom.** The harness refuses any such push (deny rules `Bash(git push * main)`, `Bash(git push *:main)`, `Bash(git push *HEAD:main*)`).

**Cause.** Changes reach `main` only through a PR behind the required checks (D-25); the deny rules make the process rule mechanical, and the `main` ruleset backs it on GitHub.

**Rule.** Every change, however small, goes on a task branch with a PR ([RB-02](../runbooks/claim-task.md), [RB-09](../runbooks/merge-and-release.md)). A refused push is a stop, not a puzzle ([RB-14](../runbooks/permission-denied.md)).

**Source.** `.claude/settings.json`; `development-process.md` §1.2.
