---
'@4thtech-io/transport-nostr': patch
'@4thtech-io/core': patch
'@4thtech-io/agentlink': patch
---

RELAY-DEFAULTS-SWAP (D-75): the default relays are now offchain.pub, relay.primal.net, relay.snort.social and nostr.bitcoiner.social (nos.lol and nostr.mom are replaced). New agents and new invites list only the new set. For a transition period AgentLink still reads from nos.lol and nostr.mom (`LEGACY_READ_RELAYS`, catch-up and live subscription) so waiting messages and acks arrive; it never publishes to them on its own, and a contact that still lists them in its invite or card is reached on that list.
