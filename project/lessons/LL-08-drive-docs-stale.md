# LL-08 · Copies of the specs outside the repository go stale

**Problem.** An agent was given foundation documents from the owner's Google Drive.

**Symptom.** They were out of date: decisions and fixes recorded in the repository were missing.

**Cause.** The Drive copies are snapshots from before the specs moved into the repository; nobody updates them.

**Rule.** The repository is canonical (`docs/foundation/`, `docs/process/`). Use other copies only to find history, never as the source. The Curator foundations mirror is refreshed from the repository after merges, and the repository wins when they differ (`development-process.md` §2.1).

**Source.** Owner's note, October 2026.
