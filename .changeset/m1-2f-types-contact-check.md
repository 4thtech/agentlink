---
'@agentlink/types': minor
---

Add the `contact.check` owner action (G-28): the owner's signed statement that they compared the safety code with a contact, binding exactly the contact's agent ID and the pairing's transcript digest, each in its one canonical encoding; any other spelling, an unknown key or another op's params is rejected, never normalised. Adds it to `OWNER_ACTION_OPS` and the owner-action union, with a typed signed wrapper.
