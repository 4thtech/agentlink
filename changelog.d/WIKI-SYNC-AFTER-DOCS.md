---
section: Changed
---

- The wiki sync can now generate the 4thTech Docs copy from `main` after the release docs PR merges: `tools/docs/wiki-sync.mjs --ref main --version X.Y.Z` (WIKI-SYNC-AFTER-DOCS, S1). The commit must be on `main`, and the wiki's state file records the version and the exact commit. The tag flow is unchanged.
