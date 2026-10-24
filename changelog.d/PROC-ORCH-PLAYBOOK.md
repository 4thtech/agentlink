---
section: Changed
---

- Process (PROC-ORCH-PLAYBOOK, S1, owner instruction 2026-10-23): new orchestrator playbook (`docs/process/orchestrator-playbook.md`). The orchestrator never implements and keeps 8–15 workers busy; routing now names four models (Haiku 5.5, Sonnet 5.5, Opus 5.5, Fable 5.1 for security audits); merge-queue, review-recording and builder rules are written down, with `tools/orchestrator/record-ir.py` and `tools/orchestrator/watch-queue.sh`.
