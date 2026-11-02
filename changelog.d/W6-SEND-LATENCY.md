---
section: Fixed
---

- Sending a message or accepting an invite no longer waits about 10 s when one relay is slow (W6-SEND-LATENCY, S1, 07 §4.2): the send answers as soon as 2 relays have the message, as the delivery rule already defines it. The other relays finish in the background and still count in relay health; with fewer than 2 relays, nothing changes and the message is retried as before.
