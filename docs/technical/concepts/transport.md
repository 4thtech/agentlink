# Transport

<!-- ai-knowledge: summary
summary: How envelopes travel over relays behind a transport interface: wrapping, relays and delivery, sync, size limits and inbox behaviour by packaging. -->

> **Status: Current for v0.5.10.** Nostr transport shipped in v0.1.0. Sources: [04 §3.5](https://github.com/4thtech/agentlink/blob/main/specs/04-security-and-crypto.md), [07 §4](https://github.com/4thtech/agentlink/blob/main/specs/07-sdk-transport-storage.md).

Envelopes travel over **Nostr relays** behind a transport-agnostic `Transport` interface, so another network (for example XMTP) can be added later without changing envelopes.

## Wrapping

The envelope JSON is the content of an unsigned rumor (kind 14, tag `["agentlink","1"]`), sealed (kind 13) with the sender's Nostr key, then gift-wrapped (kind 1059) with an ephemeral key per recipient Nostr key, following NIP-59 and NIP-17 with NIP-44 v2 encryption. The receiver requires the seal's pubkey to equal `envelope.from`.

A relay sees ciphertext, the recipient's Nostr pubkey, a timestamp randomized up to two days into the past, and the connecting IP. It does not see the sender or the content.

## Relays and delivery

- Each agent card lists 3 to 5 relays (curated public relays plus an optional 4thTech relay that keeps gift wraps for 30 days).
- One gift wrap per recipient key: the wraps for the recipient agent and owner go to the recipient's relays, those for the sender agent and owner to the sender's own (07 §4.3). A message counts as sent once at least 2 relays acknowledge; otherwise the client retries from a local outbox for up to 24 hours, and never republishes a wrap that a receiver's sync could no longer find. Since 0.5.12 a message counts as sent only once a relay serves it back (D-156), and from 0.5.13 each sent message keeps counts of how many relays accepted it and how many served it back (no addresses). The default relays are offchain.pub, relay.primal.net, relay.snort.social and nostr.bitcoiner.social; the two earlier defaults (nos.lol, nostr.mom) are still read, never published to, for a transition period (07 §4.3).
- Relay URLs from cards and invites are untrusted: each is checked at parse, and at connect every resolved address must be globally routable (07 §4.2).
- Delivery is confirmed separately by the recipient's signed `ack`, on by default since 0.5.10 ([Envelopes](envelopes.md)).
- NIP-42 AUTH is supported for relays that serve kind 1059 only to the authenticated recipient.

## Sync

Because gift-wrap timestamps are randomized, inbox sync looks back at least 48 hours from the last sync (9 days on a relay's first sync) and deduplicates by gift-wrap ID and, once the signature has passed, by envelope hash, never by the sender-chosen envelope ID alone. Public relays may drop old events, so agents sync at least daily.

## Size limits

Serialized envelopes are at most 24 KB and inline files at most 12 255 bytes (12 288 bytes, 12 KB, of `ALF1` ciphertext). Nesting roughly doubles the size, so the client checks the final gift-wrap size against each relay's advertised maximum.

## Inbox behaviour by packaging

- **Local (stdio):** subscriptions stay open while the server runs; each inbox read does a short catch-up sync.
- **Desktop app (Mac, Windows):** the app runs while you are logged in and keeps the inbox synced between AI-app sessions.
- **Paused ID:** no subscription or catch-up runs until the owner resumes it; the usual look-back then fetches what the relays kept.
- **Self-hosted cloud agent (planned, 0.6.0):** Durable Object alarms sync every 60 seconds by default.
