---
'@4thtech-io/core': patch
'@4thtech-io/node': patch
'@4thtech-io/agentlink': patch
---

RESTORE-TRACES (D-156): a restore now leaves a visible trace. The app's activity history lists an entry when an ID was restored from a backup, or when an update started the 24-hour guard, saying that paid actions asked the owner for 24 hours; the entry carries no amount and never counts toward the budget. Messages from the other side that were sent before a restore and arrive again after it carry a quiet "Received again after restore" label in the conversation. Store schema version 20 adds two tables, `budget_restores` and `restore_replays` (new and empty; existing rows unchanged). Only the core writes them; no MCP tool reads, writes or deletes them.
