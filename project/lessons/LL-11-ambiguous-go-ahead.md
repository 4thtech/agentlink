# LL-11 · An ambiguous owner message is not a merge go-ahead

**Problem.** The owner wrote "merch went green" while S2 PRs were waiting.

**Symptom.** The safety classifier refused to treat it as a "merge" go-ahead.

**Cause.** A go-ahead releases S2 and sensitive-path changes; a typo or a status remark cannot carry that weight. Silence is not a go-ahead either.

**Rule.** A go-ahead is an unambiguous owner message in chat, with its scope clear. When in doubt, ask: "Do you want me to merge #<n> (and which others)?" Record the exact words in the PR body ([RB-09](../runbooks/merge-and-release.md)).

**Source.** Orchestrator session, October 2026; `delivery-process.md` §4.
