# Changelog fragments

Every PR that changes user-visible behaviour, a spec or the process adds **one file here** instead of editing `CHANGELOG.md`. Parallel PRs then never touch the same line, so the merge queue stops conflicting after each merge (OPS-REL-4, [`versioning.md`](../docs/process/versioning.md) §5).

## File name

`changelog.d/<card-id>.md`, or `<card-id>-<slug>.md` when one card needs several files (for example `M1-9w.md`, `OPS-REL-4-docs.md`). Any other `.md` file in this folder is also read, except this `README.md`.

## Format

The section is named by front matter or by a heading. Use exactly one of the Keep a Changelog sections: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`. Then one or more bullet lines, each starting with `- ` and carrying the task ID. A breaking change starts with **BREAKING:**.

```markdown
---
section: Changed
---

- Short sentence in user vocabulary (M1-9w, S1, 07 §4.2): what changed and why it matters.
```

Several sections in one file work with headings instead of front matter:

```markdown
### Added

- New thing (M1-9x).

### Fixed

- Old bug (M1-9x).
```

A change that needs no entry (a refactor, a test-only change under a source path) adds a fragment with `section: none` and one line saying why. It records the decision for CI and is dropped at release:

```markdown
---
section: none
---

Internal refactor, no behaviour change.
```

## What happens at release

The release version job runs `node tools/release/roll-changelog.mjs roll`. It folds every fragment, plus any legacy lines still under `## [Unreleased]` in `CHANGELOG.md`, into the new `## [<version>] - <date>` section, grouped by section in the order above (fragments in file-name order), deletes the fragments and leaves `[Unreleased]` empty. An unknown section name fails the roll and names the file. It refuses only when there are no fragments and nothing under `[Unreleased]`.

CI (`tools/release/check-changelog-fragment.mjs`) fails a PR that changes CLI or library source, a foundation spec, a process doc or `AGENTS.md` without a fragment, and warns when `CHANGELOG.md` `[Unreleased]` is edited directly.
