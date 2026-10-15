# Transport

> **Status: Design.** Planned for v0.1.0 (M1a). Sources: [04 §3.5](https://github.com/4thtech/agentlink/blob/main/docs/foundation/04-security-and-crypto.md), [07 §4](https://github.com/4thtech/agentlink/blob/main/docs/foundation/07-sdk-transport-storage.md).

Envelopes travel over **Nostr relays** behind a transport-agnostic `Transport` interface, so another network (for example XMTP) can be added later without changing envelopes.

## Wrapping

The envelope JSON is the content of an unsigned rumor (kind 14, tag `["agentlink","1"]`), sealed (kind 13) with the sender's Nostr key, then gift-wrapped (kind 1059) with an ephemeral key per recipient Nostr key, following NIP-59 and NIP-17 with NIP-44 v2 encryption. The receiver requires the seal's pubkey to equal `envelope.from`.

A relay sees ciphertext, the recipient's Nostr pubkey, a timestamp randomized up to two days into the past, and the connecting IP. It does not see the sender or the content.

## Relays and delivery

- Each agent card lists 3 to 5 relays (curated public relays plus an optional 4thTech relay that keeps gift wraps for 30 days).
- A message is published to the recipient's relays and the sender's own; it counts as sent once at least 2 relays acknowledge. Otherwise the client retries from a local outbox for up to 24 hours.
- NIP-42 AUTH is supported for relays that serve kind 1059 only to the authenticated recipient.

## Sync

Because gift-wrap timestamps are randomized, inbox sync looks back at least 48 hours from the last sync and deduplicates by envelope ID. Public relays may drop old events, so agents sync at least daily.

## Size limits

Serialized envelopes are at most 24 KB and inline files at most 12 255 bytes (12 288 bytes, 12 KB, of `ALF1` ciphertext). Nesting roughly doubles the size, so the client checks the final gift-wrap size against each relay's advertised maximum.

## Inbox behaviour by packaging

- **Local (stdio):** subscriptions stay open while the server runs; each inbox read does a short catch-up sync.
- **Desktop app (M2):** the tray app keeps subscriptions open between harness sessions.
- **Cloud (M2):** Durable Object alarms sync every 60 seconds by default.
