---
'@agentlink/node': minor
'@agentlink/crypto': minor
---

Add the agent's local store on SQLite: every table of the store schema, with its keys, unique constraints, value types and row limits enforced by SQLite itself, forward-only migrations (a store written by a newer version is refused, never downgraded), WAL mode and write transactions that several processes can share for one agent, and an inter-process lock for longer critical sections. Sensitive columns are encrypted at rest with AES-256-GCM under the agent's store key from the keychain, bound to their table, column and row, and keyed digests use an index key derived from the store key. `@agentlink/crypto/keystore` gains the store column cipher.
