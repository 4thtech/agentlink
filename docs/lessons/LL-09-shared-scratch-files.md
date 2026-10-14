# LL-09 · Parallel agents overwrite each other's scratch files

**Problem.** Several workers wrote intermediate files to the same scratch directory under fixed names (`diff.txt`, `report.md`).

**Symptom.** Files one worker had written were overwritten by another, so later steps read the wrong content.

**Cause.** Workers run in parallel and share the session's scratch directory; fixed names collide.

**Rule.** Every brief gives the worker a unique scratch prefix (task ID plus a short tag, for example `rb-`), and workers name every scratch file with it ([RB-03](../runbooks/worker-brief.md)).

**Source.** Orchestrator sessions, October 2026.
