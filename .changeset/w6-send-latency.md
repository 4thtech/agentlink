---
"@4thtech-io/transport-nostr": patch
"@4thtech-io/agentlink": patch
---

W6-SEND-LATENCY: sending a message and accepting an invite return as soon as 2 relays have the message, instead of waiting up to 10 s for the slowest relay. The other relays still finish in the background and update relay health.
