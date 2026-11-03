---
section: Fixed
---

- The app no longer quits silently while you use it (W8-F25, owner test of 0.4.10): `agentlink ui` now closes after 30 minutes without use (any open page or request counts as use) instead of 30 minutes after it started. Every exit (idle, Ctrl+C, closing the terminal, a stop signal) prints one line: "AgentLink closed. Run `agentlink` to open it again." The open page says the same instead of "Try again in a minute".
