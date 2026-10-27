---
'@4thtech-io/node': minor
---

MSG-FILES-IO-c: the local app's Messages reads, `GET /api/ui/messages` (conversations) and `GET /api/ui/messages/:contactId?box=in|out&limit=&cursor=` (one contact's Inbox or Sent). Read-only, behind the owner's browser session; allowlisted fields only, fixed error codes, never a read mark for the AI.
