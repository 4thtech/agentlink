---
section: Added
---

- A daily, read-only check of the default relays runs on GitHub's runners (RELAY-DEFAULTS-HEALTH, S1): it asks each relay for recent gift-wrap ids without a login, publishes nothing, and writes the result to the job summary.
