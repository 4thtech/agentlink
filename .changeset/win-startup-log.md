---
"@4thtech-io/agentlink": patch
---

WIN-STARTUP-LOG: when the app host cannot start, it writes one fixed line (the reason and a short error code, never a message or path) through its redacting logger to stderr, so the desktop app can keep it in core.log.
