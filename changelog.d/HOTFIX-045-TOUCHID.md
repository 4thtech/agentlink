---
section: Fixed
---

- Touch ID instead of the backup code when no agent is open (HOTFIX-045-TOUCHID, S2; 04 §2.3.1, §2.5; 11 §5): the app now finds your Touch ID even when no agent is open. When Touch ID can't be used, the sheet says why instead of silently asking for the backup code, and if this computer doesn't have Touch ID set up for AgentLink yet (for example an owner set up before 0.3.0) you can switch once right there: your backup code, then one touch.
