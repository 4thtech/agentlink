---
section: Fixed
---

- An ID whose key is missing from this computer no longer stops AgentLink with "couldn't open its page" (WIN-BROKEN-ID, S2, 04 §2.5): your other IDs open as usual, and Home names that ID with three choices: Restore from backup, Remove from this computer (after Touch ID, Windows Hello or your master code and typing its name; its folder is moved to `~/.agentlink/set-aside`, never deleted, and nothing is sent to your contacts) and Continue without it.
- A new ID that could not be finished is now removed folder first, then its keys, so a failed clean-up never leaves an ID without its key (WIN-BROKEN-ID).
- `agentlink doctor` no longer cuts its sentences short, and names an ID whose key is missing with the fix (WIN-BROKEN-ID).
