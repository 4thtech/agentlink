---
'@agentlink/core': patch
'@agentlink/node': patch
---

Adds the per-agent publisher lease (`client.publisherLease()`, store schema version 3 with the `publisher_lease` table) and bounds staged pairing messages: one still unsent after 24 h is marked not delivered, and one that keeps failing no longer blocks newer ones (`outbox_staged`).
