---
'@4thtech-io/node': patch
---

M1-UX3-DUP-CONTACTS: the local app's contact list (`GET /api/ui/contacts`) marks a newer active contact that has the same owner as an older active one with `olderSameOwner` (the older contact's ID, which the list already shows; the owner fingerprint itself never leaves). The Contacts page uses it to suggest removing the older connection; removal is the existing owner-confirmed Remove.
