@AGENTS.md

<!--
Claude Code reads CLAUDE.md; other harnesses read AGENTS.md. All shared instructions live in AGENTS.md (imported above).
Only Claude-Code-specific notes belong below.
-->

## Claude Code notes

- Delegate with the Agent tool and set `model` per the routing table in AGENTS.md (`haiku` / `sonnet` / `opus`). Use `isolation: "worktree"` for workers that write in parallel.
- The `curator-continuity` skill describes the Curator calls; the block in AGENTS.md applies even if the skill is not activated.
