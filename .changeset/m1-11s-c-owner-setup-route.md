---
'@4thtech-io/node': minor
'@4thtech-io/agentlink': patch
---

The local approval server can set up the owner from the first-run page (M1-11s-c, D-120 (1)): two setup routes, behind their own setup gate and only while no owner exists anywhere, create the owner key with one passkey gesture, a backup owner code shown once, and the agent's first card, all or nothing. The owner seed is held in memory for at most two minutes between the two steps, for one session, and wiped after. When an owner is set up from the page, the CLI logs a fixed line with the owner fingerprint to compare with `agentlink doctor`.
