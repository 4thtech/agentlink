# LL-15 · An S2 PR merges only with its RED commit checked

**Problem.** S2 work is tests-first: a `RED (expected):` commit of failing tests precedes the implementation, and the independent reviewer reproduces the red (`audit-rules.md` §3.4, [LL-14](LL-14-red-ci-emails-owner.md)).

**Symptom.** On 2026-10-14, three S2 PRs merged without a RED commit: #61 (M1-1l), #66 (M1-7b) and #67 (M1-8c). The independent review IR-M1-2e-1 on #69 found this later.

**Cause.** No step checked for the commit before merge. The builder briefs did not require it. The reviewer briefs left out the §3.4 reproduction step, so the reports had no `tests-first reproduced:` line. The orchestrator's audit (`development-process.md` §5) had no step for it, and `review-gate` only checks that the section is filled in. The reviewers did run mutation checks on parts of the work (the M1-1l wipe; the M1-7b `kc` check, wrap comparison and 300 s bound). That is partial evidence that those tests are not vacuous, but it does not replace the RED commit.

**Rule.**
- Every S2 builder brief requires the `RED (expected):` commit, its local red run and the evidence in the PR (`development-process.md` §7.2).
- Every S2 reviewer brief includes the §3.4 reproduction step, and the report carries the `tests-first reproduced: yes|no` line (`audit-rules.md` §4.2, §4.3).
- Before merge, the orchestrator checks that the RED commit is on the branch and that the report says `reproduced: yes` (`development-process.md` §5, step 5a). If either is missing, the PR does not merge.

**Source.** IR-M1-2e-1 on #69, 2026-10-14. Related: [LL-14](LL-14-red-ci-emails-owner.md).
