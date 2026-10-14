---
'@agentlink/core': minor
---

Add the core skeleton: `AgentLinkClient.create` over a KeyStore, a Store, a store cipher and an approval channel. The `Store` interface covers every table of the local store schema (07 §3, with the G-9 delivery, idempotency, owner-authority and budget tables), with synchronous all-or-nothing transactions, compare-and-set counts and schema rules enforced by the store itself, plus an in-memory Store for tests. The `ApprovalChannel` interface only delivers requests: nothing it returns approves anything without an owner signature. Identity issues the agent card signed by the owner and endorsed by the agent key, records the agent ID with a random storage prefix, and rotates to the next key epoch with a new card. Contacts are keyed by agent ID, added only from a verified card, follow the re-pair and revocation rules, take card updates, and can be blocked (later envelopes are dropped) or removed; display names are marked self-declared.
