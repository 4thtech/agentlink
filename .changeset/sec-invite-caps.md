---
'@4thtech-io/types': patch
'@4thtech-io/core': patch
'@4thtech-io/mcp-tools': patch
'@4thtech-io/node': patch
'@4thtech-io/agentlink': patch
---

SEC-INVITE-CAPS (D-156): invites the AI makes with `agentlink_create_invite` are capped by the owner's policy `contacts.aiInvites` (default at most 3 open, 5 per rolling 24 hours, each for 24 hours; 0 turns them off; absent reads as the defaults), refused with `INVITE_LIMIT` in plain words; owner invites are neither limited nor counted. A contact paired through an AI-made invite waits for the owner (`waitingForOwner`): its messages arrive, but core refuses every outbound message, file, terms message, proof and receipt to it (`contact_waiting_owner`, `CONTACT_WAITING_OWNER`) until the owner keeps it with the new owner action `contact.keep` (local app, presence, `POST /api/ui/contacts/:ref/keep`) or removes it. Store schema version 18 adds `invites.created_by` and `contacts.waiting_owner` (nullable; existing contacts stay kept). People, Home and the widget show "New contact via your AI"; Rules › More rules edits the caps.
