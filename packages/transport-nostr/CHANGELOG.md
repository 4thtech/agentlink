# @4thtech-io/transport-nostr

## 0.1.1

### Patch Changes

- 088b5fd: Live relay subscriptions (M1-9s): `Transport.subscribe` and `AgentLinkClient.subscribeInbox` in the core; the MCP server's background loop receives new messages and handshakes as they reach a relay, with a 5-minute fallback catch-up, and closes the subscription on lease loss and on shutdown.
- Updated dependencies [4dcc340]
- Updated dependencies [af00aaa]
- Updated dependencies [b26ef46]
- Updated dependencies [2a6716d]
- Updated dependencies [e768cd1]
- Updated dependencies [58df129]
  - @agentlink/crypto@0.1.1
  - @agentlink/types@0.1.1
  - @agentlink/log@0.1.1

## 0.1.0

### Minor Changes

- e46e352: Add the NIP-59 gift wrap and unwrap of an envelope (04 §3.5, §3.1.1; 07 §4.1, §4.2). `wrapEnvelope(envelope, recipients, keys)` puts `JCS(envelope)` into an unsigned kind 14 rumor tagged `["agentlink","1"]`, seals it (kind 13) through `EnvelopeKeys.signNostr` and gift-wraps it (kind 1059) once per distinct recipient key (1 to 8) with an ephemeral key from `@agentlink/crypto`, NIP-44 v2 throughout; seal and gift-wrap `created_at` are drawn uniformly from the last 2 days. Envelopes over 24 576 bytes (`ENVELOPE_MAX_BYTES`) are refused before any key is used, and each result carries the gift wrap's event and relay-frame size in bytes. `unwrapGiftWrap(event, keys, {epoch})` fails closed with a `TransportError` unless both signatures verify, the rumor key equals the seal key, the `agentlink` tag is present, the rumor content is at most 24 576 bytes (checked before parsing), the envelope parses strictly and the seal key equals `envelope.from`. New devDependency: `nostr-tools` 2.25.2, for the interop tests only.
- 7355a84: Add the relay pool, publish and outbox delivery (07 §4.2, §4.3). `RelayPool.publish(event, relays)` sends one signed gift wrap to exactly the relays it is given and nowhere else, all attempts in parallel, and reports a fixed reason per relay (`sent` once 2 relays return OK); relay-sent text never reaches a result, a log or an error. Every connect and reconnect resolves the host and refuses the relay unless every answer is globally routable (IPv4 and IPv6 special-purpose blocks, 6to4, Teredo, NAT64, mapped and CGNAT addresses), then hands the connector the checked address, which the NIP-11 fetch uses too. Inbound frames above 131 072 bytes are dropped before they are parsed. NIP-11 `max_message_length` is read, bounded and cached, and a relay that cannot carry the wrap is skipped. NIP-42 AUTH is signed through `EnvelopeKeys.signNostr`, only when a relay asks for it and the caller's `mayAuthenticate(relay)` hook allows it (deny by default). At most 64 connections, idle ones closed after 5 minutes, a relay that does not connect within 10 s skipped for that attempt. `OutboxWorker` republishes the stored wrap of each `outbox` row (never re-wrapping) with backoff of 30 s doubling to 1 h, marks it `sent` at 2 OKs and `not_delivered` after 24 h, and reads and writes rows through an injected `OutboxPersistence` whose status writes are compare-and-set on `pending` (a revoked row is never overwritten); a stored give-up time is capped at created + 24 h. Sockets, DNS and NIP-11 are injected interfaces (`RelayConnector`, `HostResolver`, `Nip11Fetcher`), implemented by `@agentlink/node` and the clients. New dependencies on `@agentlink/types` and `@agentlink/log`.
- 8efcc8e: Add subscribe and sync (07 §4.2, §3.2). `SyncEngine.sync({relays, identities, onEnvelope, budgetMs})` sends `REQ {kinds: [1059], "#p": own keys, since}` to each relay, with `since` = the relay's saved cursor minus 48 h and 300 s (a relay with no cursor: 9 days back), opens each gift wrap and hands the envelope to the caller once however many relays serve it. The cursor is saved only after the relay's end-of-stored-events marker and every event of the pass was handled; a failed or slow relay, or an item the handler returns as `retry`, keeps its cursor. Dedup is by gift-wrap id and a wrap is marked seen only with its processed outcome; an envelope id is recorded only when the handler reports `verified`, and is given to the handler as a hint (`envelopeSeen`), never used to skip an item (an unverified envelope's id is chosen by its sender). The default budget is 3 s and the result is flagged `partial` when any relay did not finish. `SyncEngine.subscribe` keeps the subscription open and reconnects with a 5 s to 5 min backoff. Stored events are read in pages (`limit` 500 with `until`), because a relay may cap what it returns per filter; the cursor moves only after the last page, and an optional `getResume`/`setResume` pair lets a pass cut short continue at its page next time. Frame counts, queued events, newly opened wraps per pass and the in-memory dedup caches are bounded; relay text and event content never reach a log or a result. `seenPruneBefore` gives the seen-set pruning bound (7 days, or the oldest `since` a sync can still ask for). The cursor and the seen-set are an injected `SyncPersistence`; `markSeen` is optional because core writes `seen` in its own transaction (07 §3.2). `RelayPool` gains `connect` (a pinned link that is not idle-closed), `onRelayClose` and `isClosed`.
- 2b46ba4: The outbox stops republishing a wrap once a receiver's sync could no longer find it (G-49, D-71 (5); 07 §3.2, §4.2). `OutboxWorker` now takes give_up_at as the earliest of the stored value, `created_at + 24 h` and the signed wrap's own `created_at + SYNC_LOOKBACK_SECONDS + SYNC_SKEW_SECONDS` (48 h + 300 s), recomputed from `wrap_json` on every pass, and schedules no retry past it. A row that reaches the bound without 2 `OK`s is `not_delivered` (timeout), as before; a wrap dated close to 48 h back therefore gets a short retry window. Revisit in M2.

### Patch Changes

- f805b00: Adds `DEFAULT_RELAYS`, the single source for the default public relay set (nos.lol, relay.primal.net, relay.snort.social and nostr.mom).
- Updated dependencies [1377cb5]
- Updated dependencies [0baa0a5]
- Updated dependencies [7121fa2]
- Updated dependencies [2172526]
- Updated dependencies [9c27388]
- Updated dependencies [32b70f5]
- Updated dependencies [cb7c956]
- Updated dependencies [fecd9a3]
- Updated dependencies [4287032]
- Updated dependencies [1feb21c]
- Updated dependencies [d8228d2]
- Updated dependencies [39b1d8c]
- Updated dependencies [427592d]
- Updated dependencies [e6a146d]
- Updated dependencies [a71148b]
- Updated dependencies [810e746]
- Updated dependencies [7470286]
- Updated dependencies [667dc38]
- Updated dependencies [9722c8a]
- Updated dependencies [66e997c]
- Updated dependencies [e02996f]
- Updated dependencies [a1465a6]
  - @agentlink/log@0.1.0
  - @agentlink/crypto@0.1.0
  - @agentlink/types@0.1.0
