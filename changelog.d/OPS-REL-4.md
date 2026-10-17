---
section: Changed
---

- Changelog fragments (OPS-REL-4, S2, process): a PR now adds `changelog.d/<card-id>.md` instead of a line under `CHANGELOG.md` `[Unreleased]`, so parallel PRs stop conflicting in the merge queue. The release roll (`tools/release/roll-changelog.mjs`) folds the fragments and any legacy `[Unreleased]` lines into the version section and deletes them; a new CI step fails a user-visible, spec or process PR with no entry and warns on a direct `[Unreleased]` edit. Format in `changelog.d/README.md`.
