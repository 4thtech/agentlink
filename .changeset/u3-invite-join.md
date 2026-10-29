---
'@4thtech-io/agentlink': patch
'@4thtech-io/core': patch
'@4thtech-io/node': patch
'@4thtech-io/types': patch
---

Join from an invite link (U3-invite, 08 §4, 06 §8, b11 §33): `agentlink join '<invite link>'` checks the invite on this computer and opens the AgentLink app with it waiting; after setup (or at once when AgentLink is already set up) the app asks "Accept {name}'s invite?" and accepts only with Touch ID (or the backup code). When the app is already open, `join` hands the invite to it with one local request. A bad or incomplete link gets one fixed line and exit code 2, and the link is never printed, logged or saved.
