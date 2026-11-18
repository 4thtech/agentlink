---
'@4thtech-io/transport-nostr': patch
'@4thtech-io/core': patch
---

A contact-details update that only the old servers accepted is no longer treated as delivered: it keeps retrying until one of the contact's current servers accepts it. Other messages are unchanged.
