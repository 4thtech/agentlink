---
'@4thtech-io/agentlink': minor
---

`agentlink init --hook` adds an optional start-of-session note to Claude Code (a `SessionStart` hook that runs `agentlink status --brief`). It is a separate opt-in with its own exact diff and confirmation, runs the installed program by absolute path (never `npx`), and a settings file that is not valid is left alone. `status --brief` prints counts and contact names only.
