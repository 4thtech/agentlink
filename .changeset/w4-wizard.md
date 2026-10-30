---
'@4thtech-io/node': patch
'@4thtech-io/agentlink': patch
---

W4-WIZARD (W4 UX v2 layer 1): first run is Get started, four steps each on its own route (`/start/app`, `/start/connect`, `/start/connected`, `/start/invite`) with a progress bar and "Skip to Home". Pick your AI app from tiles (found on this computer or not yet), then one Touch ID creates the agent and connects it (D-140; the backup code is still shown once), then Connected (or, when the app's settings can't be written, the agent is kept and Connect is offered), then an optional invite step. The same steps serve New agent (`/start/app?add=agent`) and Connect another AI app. The app opens Get started by itself only while setup is incomplete (no owner, no agent, or no AI app connected), read from the real state; the Home card "Get started · n of 3 done" is exported for Home.
