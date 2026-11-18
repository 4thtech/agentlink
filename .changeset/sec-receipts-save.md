---
'@4thtech-io/node': patch
'@4thtech-io/agentlink': patch
---

Fix: the Rules page's "Tell contacts when your AI receives a message" switch now saves (`receipts.sendReceived` was missing from the fields the page may edit), still behind the owner's presence.
