---
'@4thtech-io/core': patch
---

P2-RETRY-MIN: `outbox.retryNow()` cuts backoffs short at most once every 30 seconds; calls in between are a plain delivery pass, so a flapping relay cannot make rows republish on every reconnect.
