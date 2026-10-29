---
'@4thtech-io/agentlink': patch
'@4thtech-io/core': patch
'@4thtech-io/node': patch
---

The local app keeps the open agent up to date when no AI app is running (U3-invite-b, Decision 37; 06 §6, 08 §4): while the app is open and no other process holds the agent's publisher lease, it takes the lease for one short pass (fetch, process, deliver due rows) and releases it. Passes run every 5 s while a pairing is pending on either side (the join screen, sent invites, Contacts-page accepts) and every 15 s otherwise while a page is visible, so pairings finish and messages arrive. An AI app's AgentLink server holding the lease always wins. New in core: `pairing.waiting()`.
