---
'@4thtech-io/core': minor
---

When a contact's owner revokes that agent, your agent now voids every approval still waiting for the owner and every unfinished part of an agreement with that contact, in the same step that records the revocation, and reports what it stopped. Delivery acknowledgements are queued for the delivery pass instead of sent during an inbox sync, a status check no longer counts a contact's acknowledgements as unread once their type is known, and a key store that cannot list the agent's keys no longer makes the whole sync fail (M1-7h-b).
