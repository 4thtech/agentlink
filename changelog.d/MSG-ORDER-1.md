---
section: Fixed
---

- Messages sent or received within the same second now keep their order in a conversation (MSG-ORDER-1, audit R2-UI-09): the app breaks a tie of the time by the order this computer stored them (a message sent first shows first; received ones in the order they arrived, since the protocol time has whole seconds only). No protocol or store schema change.
- When the relays come back, queued messages waiting to retry go out at once instead of at their next retry time (OUTBOX-NOW-1). Retry limits are unchanged and the same stored message is resent, never a second copy.
