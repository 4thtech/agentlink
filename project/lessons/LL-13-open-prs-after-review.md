# LL-13 · Failed-run emails come from PR runs under the owner's account; open PRs only after review

**Problem.** The owner is e-mailed for every failed workflow run on a pull request opened under his account.

**Symptom.** A stream of failure e-mails, most of them `review-gate` on draft PRs whose independent review was still pending: nothing was broken, the evidence simply did not exist yet.

**Cause.** Builders opened a draft PR at claim time (so it doubled as the task claim), before the review. `review-gate` is red until the `IR-…` line is in the PR body, so every early push produced a failed run and an e-mail.

**Rule.** CI runs on branch pushes (`ci.yml`), which covers lint and tests (never a deliberate red run, [LL-14](LL-14-red-ci-emails-owner.md)). The PR is opened (not as a draft) only after the independent review passes, already carrying the `IR-…` line ([RB-04](../runbooks/independent-review.md), `delivery-process.md` §2 step 7a). Claims are `board.md` rows with the branch name ([RB-02](../runbooks/claim-task.md)). Once a PR exists, each push runs CI twice (push and pull request); that duplicate is accepted.

**Source.** CHORE CI-PUSH, October 2026 (owner decision).
