# LL-10 · zsh treats `?` in a URL as a glob

**Problem.** `gh api repos/4thtech/agentlink/pulls?state=all` in zsh.

**Symptom.** `zsh: no matches found: repos/4thtech/agentlink/pulls?state=all`; the command never ran.

**Cause.** zsh expands `?`, `*` and `[` as filename patterns and, by default, fails when nothing matches.

**Rule.** Quote such arguments: `gh api 'repos/4thtech/agentlink/pulls?state=all'`, or pass parameters as flags: `gh api -X GET repos/4thtech/agentlink/pulls -f state=all`.

**Source.** Orchestrator sessions, October 2026.
