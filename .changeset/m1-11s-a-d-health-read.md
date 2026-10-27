---
'@4thtech-io/node': minor
'@4thtech-io/ui': minor
'@4thtech-io/agentlink': patch
---

M1-11s-a-d: the local app's health read, `GET /api/ui/health`, answering a fixed shape (agent running, paused, not running or needs setup; relay counts; last sync time; app version), cached for 3 s and bounded, behind the owner's browser session. The app's status bar polls it (with backoff, paused while hidden) and shows Connected, Paused, Not running or Needs setup in a polite live region, instead of "Checking…" forever. `AppShell` gains the `not-running` and `needs-setup` states.
