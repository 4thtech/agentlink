---
'@4thtech-io/agentlink': patch
---

The free test credits claim reads at most 512 bytes of a limit answer, waits at least 5 minutes (and follows the service's Retry-After, up to a day) before asking again, and stops asking when the service answers with a permanent client error.
