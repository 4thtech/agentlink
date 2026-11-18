---
'@4thtech-io/core': patch
'@4thtech-io/node': patch
'@4thtech-io/agentlink': patch
---

Fix: deleting history no longer fails at random with "What would be deleted changed" when a contact's received receipt (or your own) lands after the delete sheet listed the items or during the 10-second Undo. Receipts are not part of the confirmed list: they still go with the message they name, and a new message or saved file still stops the delete.
