---
'@4thtech-io/node': patch
'@4thtech-io/agentlink': patch
---

The master code shown once at first run and after a restore survives a reload of its step until "I saved it" (server memory, this page session, 10 minutes); after a restart the app says it was not saved and offers a new one; a restore closed before its new master code reached the page is rolled back to "Finish restoring" at the next start (REL051-CF3).
