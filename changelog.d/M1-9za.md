---
section: Added
---

- Owner commands `agentlink contacts rename <contactId> <name>` and `agentlink contacts remove <contactId>` (M1-9za, S2, 04 §2.5.1, 06 §8): fix two contacts that show the same name (`AMBIGUOUS_CONTACT`) by giving one your own name or removing the one you no longer need. Both need your owner code in a terminal you opened; your AI can't do either, and no AI tool was added. `agentlink contacts` now lists each contact's ID. Spec: new owner-action ops `contact.rename` and `contact.remove` (proposed, owner confirms at merge).
