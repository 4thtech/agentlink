# LL-04 · Turborepo rewrites `AGENTS.md` unless told not to

**Problem.** Running `turbo` for the first time in the monorepo skeleton.

**Symptom.** `AGENTS.md` changed on disk without anyone editing it.

**Cause.** Turborepo's agent guidance feature edits `AGENTS.md` when it detects an agent. That would change the agent rules silently and can push the file over its 8 KB budget (`context-budget`).

**Rule.** `turbo.json` sets `"agentGuidance": false`. Keep it. After any new tool's first run, check `git status` for unexpected changes to `AGENTS.md`, `CLAUDE.md` or `.claude/`.

**Source.** M0-2d (PR #2) threat note; `turbo.json`.
