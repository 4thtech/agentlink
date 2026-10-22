---
section: Fixed
---

- CI no longer stalls on a slow package mirror or loses the e2e keyring mid-run (CHORE-CI-HARDEN-1): Playwright browsers are cached by version, their install is time-bounded with one retry, and the e2e keyring is supervised and restarted at once, with a clear "runner keychain unavailable" message if it still fails.
