---
section: Changed
---

- The card counts in `docs/process/backlog.md` are generated (CHORE-BACKLOG-COUNTS, S0): `node tools/docs-status/index.mjs` counts the card headings for M0, M1 (M1a, M1b), M2 and M3, and `--check` (in `pnpm lint` and CI) fails when they are stale. Authors no longer edit the count rows, so card-adding PRs stop conflicting on them; a merge conflict there is resolved by rerunning the generator.
