---
section: Changed
---

- A slow or hanging relay information document no longer delays sending to a relay that works (M1-5b-c): the wait is limited to 3 seconds and 64 KiB, and the relay is then used with default limits. Messages stuck because fewer than 2 relays can take them now say why, relay health names relays without their address path, and retries are spread out so queued messages do not all retry at once.
