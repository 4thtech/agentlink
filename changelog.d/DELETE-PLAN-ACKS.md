---
section: Fixed
---

- Delete history works when a received receipt arrives in between (DELETE-PLAN-ACKS, S2, 04 §4.2, 07 §3.8): a receipt that lands after the delete sheet listed the items, or during the 10-second Undo, no longer makes the delete fail with "What would be deleted changed. Check it again." Receipts follow the message they name and are not part of the confirmed list; a new message or saved file still stops the delete, and nothing you did not see is deleted.
