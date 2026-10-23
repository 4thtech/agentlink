---
'@4thtech-io/core': minor
---

The activity feed (`client.activity.list`) now lists messages and files, sent and received (one entry per message, kind `message` or `file`, with each file's sanitized name, size and whether it was removed), and requests from unknown senders by their sender code. Proof, message, file and blocked-contact entries carry the contact's display name (an owner alias or the restricted name with its identity label, never the raw declared name), and proof, message and file entries carry their cost: free, charged, reserved, not charged or unknown. No payload, URL, file key or locator ever reaches an entry.
