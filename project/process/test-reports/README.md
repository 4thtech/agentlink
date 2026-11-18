# Test reports

Reports of end-to-end and acceptance test runs: what was tested, how to rerun it, and the measured results. Each report is named `YYYY-MM-DD-<task-id>-<topic>.md`. A report records results that were actually measured; a run that has not happened yet is marked as pending, never filled in by hand.

| Date | Report | Task | What it covers |
|---|---|---|---|
| 2026-10-15 | [M1-13a e2e: two agents on two harnesses](2026-10-15-m1-13a-e2e.md) | M1-13a | Pair and message between Claude Code and Codex (and Claude Code on both sides), deterministic and LLM-driven (nine dispatches; run 9, Claude Code on both sides, passed 21 of 21 steps), with the canary scan; the M1-12a and M1-12b transcripts |
| 2026-10-16 | [M1-22 e2e: J8 negotiate and agree over Talk](2026-10-16-m1-22-e2e.md) | M1-22 | Propose, counter, accept with one owner approval, replay and void, the owner-signed limit; deterministic (passes in CI, PR #169) and LLM steps L13 to L20 (run 9: 21 of 21 steps passed with Claude Code on both sides; Codex as the second agent has not had a full pass) |
