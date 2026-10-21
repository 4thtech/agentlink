### Changed

- When a contact's owner revokes that agent, your agent now voids, in the same step that records the revocation, every approval still waiting for the owner and every unfinished part of an agreement with that contact; an agreement the owner already approved stays approved, but nothing more of it is sent or signed. The inbox sync reports how many deliveries, approvals and agreement parts the revocation stopped (M1-7h-b, S2, 04 §3.4.2 rule 3, 07 §3.4).
- Delivery acknowledgements are now queued for the delivery pass instead of being sent while the inbox syncs, so a sync with many new messages no longer waits on relays (M1-7h-b, 07 §3.2).

### Fixed

- A status check no longer counts a contact's message as unread once it is known to be an acknowledgement or another non-message type, and a key store that cannot list the agent's own keys now fails only the fetch, not the whole inbox sync (M1-7h-b, 06 §2.0).
