# LL-14 · Red CI runs email the owner; prove red locally, and the reviewer reproduces it

**Problem.** S2 work is tests-first, and the evidence used to be a deliberately red CI run on the tests-only commit.

**Symptom.** The owner received a failure e-mail for every tests-first push, although nothing was broken: the red was intended.

**Cause.** A failed workflow run e-mails the owner ([LL-13](LL-13-open-prs-after-review.md); the owner confirmed that deliberate red push runs do too), whether the failure is intended or not. A red CI run is therefore not free evidence.

**Rule.** Prove the red locally ([RB-05](../runbooks/writing-tests.md) step 6, `audit-rules.md` §3.4):
- Commit the failing tests as their own commit with the prefix `RED (expected):`. Run them locally and put the SHA, the exact command and a short output excerpt showing the failures in the PR's "Tests-first evidence" section.
- Do not push the RED commit on its own. Push the branch once the implementation sits on top, so CI's first run is green. Keep the RED commit in the history.
- The independent reviewer checks out the RED commit, re-runs the command and confirms it fails for the stated reason. The IR report records `tests-first reproduced: yes|no`; a `no` is a finding ([RB-04](../runbooks/independent-review.md)).
- Negative controls are done locally and recorded the same way; they never go into a pushed commit.

Local evidence is checkable only because the reviewer reproduces it; the RED commit must survive on the branch until then (no rebase or squash before review).

**Source.** CHORE local-red-evidence, October 2026 (owner decision, 14 Oct). Related: [LL-13](LL-13-open-prs-after-review.md).
