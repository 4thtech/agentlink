---
'@agentlink/core': minor
'@agentlink/types': minor
'@4thtech/agentlink': minor
---

Wire `agentlink_get_approval` and the `pendingApprovals` count of `agentlink_status` to the core approval read (M1-9c-b). Every request from an unknown sender now carries its sender code from core (`RequestEntry.senderCode`, and the code on an inbox request item): the short form, or the extended form when two unknown senders share the short form (04 §2.9). `agentlink requests` shows it. `@agentlink/types` adds `toolResultCommonSchema`, the one rule set for the common tool-result fields.
