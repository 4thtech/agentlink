---
'@4thtech-io/agentlink': patch
'@4thtech-io/node': patch
---

The local app opens on Home (U3-a, D-138): `agentlink ui` opens Home instead of Activity (`openHome()` replaces `openActivity()` on the approval server), and the end of first run, and of switching to Touch ID, offers **Go to Home**. First run still opens the first-run page while no owner exists.
