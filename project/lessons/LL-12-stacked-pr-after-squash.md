# LL-12 · A stacked PR conflicts after its base is squash-merged

**Problem.** A PR was built on another unmerged PR's branch (#7 on #3) so it could use the new documents early.

**Symptom.** After the base PR and others were squash-merged, merging `main` into the stacked branch conflicted, including in files the stacked PR never changed (`00-README.md`, backlog cards).

**Cause.** A squash merge puts the base PR's changes on `main` as one new commit. Git does not recognise the base branch's original commits in it, so the same edits look like competing changes, and any later edit on `main` to those lines conflicts.

**Rule.** After the base merges, `git fetch origin && git merge origin/main`. For files you did not change, take `main`'s side (`git checkout --theirs <file>`); keep your side only for your own edits, and check each kept hunk against what `main` added. Then re-run the link and template checks, and push.

**Source.** DOCS-RB (PR #7), October 2026.
