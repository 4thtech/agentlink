---
'@4thtech-io/node': patch
'@4thtech-io/core': patch
'@4thtech-io/agentlink': patch
---

The app now opens in your browser through a private file only you can read, so other people signed in to the same computer can no longer pick up its one-time link. Local server and owner-step hardening: only your open app keeps it running, a wrong handoff can no longer delay `agentlink join`, two display marks now need the full write checks, more Windows file types that run on double-click are saved with `.download`, and owner steps are refused in more AI apps' terminals (REL051-SF4).
