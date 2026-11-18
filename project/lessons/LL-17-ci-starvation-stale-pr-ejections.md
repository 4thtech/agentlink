# LL-17 · 2026-10-22 CI starvation and stale-PR ejections: causes and fixes

**Problem.** Around twenty open pull requests shared one runner pool and one merge queue. PRs stayed red or queued for hours.

**Symptom.** Reruns piled up. Several PRs were ejected from the merge queue after a long wait with a conflict (`docs/process/backlog.md`, the generated status files) or a stale lockfile. Draft and work-in-progress PRs ran the same full suite as ready ones.

**Cause.**
- Every push to a PR ran the full suite, drafts included, on a small runner pool, so queued jobs starved each other.
- The pull-request checkout is a test merge against the base at the time of the last update. A PR that fell behind `main` looked green and failed only in the merge queue.
- Test flakes made reruns necessary: the submitter rate limit window aligned to the wall-clock hour, the e2e keyring daemon restarting mid-run, an e2e needle that matched our own random IDs, and the Playwright apt step timing out on mirrors.
- Generated status files were merged by hand instead of regenerated.

**Rule.**
- Open PRs as drafts while work continues; mark ready for review when done. Drafts skip the full suite; `ready_for_review` runs it (`ci-cd.md`, "Draft pull requests and the stale-PR precheck").
- `stale-precheck` merges the current `main` in CI and fails early on a conflict, drifted status files or a stale lockfile. Merge `origin/main` into the branch (never rebase) and regenerate: `node tools/docs-status/index.mjs`.
- Fix flakes at the cause (separate cards), not by blind reruns. The owner decides merge-queue size and the GitHub plan (recommendations in `ci-cd.md`).

**Source.** Owner, in chat, 2026-10-22 (CHORE-CI-SPEED-1); CI analysis of the same day.
