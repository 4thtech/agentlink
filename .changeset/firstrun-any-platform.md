---
'@4thtech-io/node': patch
'@4thtech-io/agentlink': patch
---

First run works on any computer and in any browser: the master code is made in the app with no passkey call (finish takes `presence: 'code'`), the desktop app's own Touch ID / Windows Hello is offered right after, and a browser passkey only where it is known to work (FIRSTRUN-ANY-PLATFORM).
