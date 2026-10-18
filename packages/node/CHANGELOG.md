# @4thtech-io/node

## 0.1.0

### Minor Changes

- 832fc4f: Add the Node relay connector, host resolver and NIP-11 fetcher for the relay pool of `@agentlink/transport-nostr`. Each relay connection goes to the address the pool checked, never to a second lookup of the name, with TLS and the `Host` header on the relay's host name; redirects are refused and proxy settings are ignored, for the WebSocket and for the NIP-11 read. Inbound messages over 131 072 bytes close the socket before they reach the pool, compression is not negotiated, and the NIP-11 read is capped at 65 536 bytes with its own 5-second deadline. New dependency: `ws` 8.22.0 (no dependencies, no install script).
- af1ce64: Add the owner's answers to requests from unknown senders and refused-row retention to the core (M1-7e-2, D-72). `client.requests` gains `accept(requestId)` (flags that one request row readable; it still counts toward the limits, and no contact or pairing is written), `ignore(fromKey)` (now also removes the key's refusals), `ignoreAll()`, `block(requestId)` (adds the key to `blocked_keys` and removes its requests, refusals and held envelopes in one transaction), `unblock(fromKey)` (by key, never by the sender-chosen envelope ID) and `listBlocked()`; `list()` entries carry `acceptedAt`. Envelopes from a blocked key are dropped at the start of 04 §3.1.1 step 5, before any decryption, with the new fixed reason `sender_blocked`; a contact's card-update from a blocked new epoch key still applies and removes the block, and a pairing message from a blocked key is always dropped. Refusals from unknown keys stop counting 7 days after the local `refused_at` (or when `refused_at` is more than 300 s ahead) and are pruned at the start of each processing pass. `requestsFullTx` now takes `now`. The idempotency `begin` refuses a `clientRequestId` outside 1 to 256 UTF-8 bytes and a tool name outside the 06 §2.0 set with `idempotency_args_invalid`. Store schema version 2: `envelopes.refused_at`, `envelopes.request_accepted_at` and the `blocked_keys` table; the Node SQLite store migrates a version 1 file forward.
- 065d02d: Add the OS keychain KeyStore: the agent's keys on macOS Keychain, Windows Credential Manager and the Linux Secret Service, under service `agentlink` and one account per agent, so several agents share a machine. The agent's identity is read from the keychain for each operation, checked against the agent ID, used and wiped; a missing or mismatched item is an error with a fix and never creates a new identity. Includes creating an agent in the keychain (never overwriting), the keychain probe and the backend choice at setup: without a usable keychain the answer is `needs_setup` unless the user opted in to the passphrase-locked file, which lands later.
- e02996f: Add the agent's local store on SQLite: every table of the store schema, with its keys, unique constraints, value types and row limits enforced by SQLite itself, forward-only migrations (a store written by a newer version is refused, never downgraded), WAL mode and write transactions that several processes can share for one agent, and an inter-process lock for longer critical sections. Sensitive columns are encrypted at rest with AES-256-GCM under the agent's store key from the keychain, bound to their table, column and row, and keyed digests use an index key derived from the store key. `@agentlink/crypto/keystore` gains the store column cipher.
- b4b340c: Add owner presence at a terminal prompt (M1-8c, D-67, D-68). `initOwner` creates the owner key on a keychain machine as the `agentlink`/`owner` keychain item in its locked `ALKO` form, under a generated owner code (or a chosen owner passphrase of at least 12 characters after an explicit opt-in), and never replaces an existing owner. `performOwnerOperation` signs one owner action or one piece of typed data, and `decideReviewedApprovals` signs reviewed approvals as one `approval.decide` or one `approval.decideBatch` (2 to 20 items, commitments never batched). Each asks for the owner code once at an interactive terminal, never from an environment variable, file, argument or pipe, and closes the owner session and wipes the code and the unlocked key when it returns. New error codes on `NodeKeyStoreError`: `owner_missing`, `owner_exists`, `owner_mismatch`, `owner_prompt_unavailable`, `owner_prompt_cancelled`, `owner_secret_refused`, `harness_detected` and `owner_operation_invalid`.
- 5844fea: Add the policy-version mark that protects an owner-signed policy from being rolled back. It is kept as a keychain item next to the agent's keys, rises only, under the agent's inter-process lock, and is read back after each update; a damaged item locks the policy instead of counting as "no policy yet". `openAgentStore` now returns it as `policyMark`, so a Node client passes it to the core and can apply owner-signed policies.

### Patch Changes

- e1f2ba0: Adds the per-agent publisher lease (`client.publisherLease()`, store schema version 3 with the `publisher_lease` table) and bounds staged pairing messages: one still unsent after 24 h is marked not delivered, and one that keeps failing no longer blocks newer ones (`outbox_staged`).
- Updated dependencies [0baa0a5]
- Updated dependencies [c887320]
- Updated dependencies [f805b00]
- Updated dependencies [7121fa2]
- Updated dependencies [2172526]
- Updated dependencies [9c27388]
- Updated dependencies [32b70f5]
- Updated dependencies [cb7c956]
- Updated dependencies [fecd9a3]
- Updated dependencies [4287032]
- Updated dependencies [1feb21c]
- Updated dependencies [2d2e13f]
- Updated dependencies [39b1d8c]
- Updated dependencies [714f2ff]
- Updated dependencies [d440819]
- Updated dependencies [1548d6c]
- Updated dependencies [e46e352]
- Updated dependencies [7355a84]
- Updated dependencies [8efcc8e]
- Updated dependencies [2b46ba4]
- Updated dependencies [716365b]
- Updated dependencies [ebc37c1]
- Updated dependencies [d25bcbf]
- Updated dependencies [6963164]
- Updated dependencies [3e86521]
- Updated dependencies [f17fbf4]
- Updated dependencies [ab59425]
- Updated dependencies [af1ce64]
- Updated dependencies [66e997c]
- Updated dependencies [05fc15a]
- Updated dependencies [2e25c52]
- Updated dependencies [df0dc36]
- Updated dependencies [e1f2ba0]
- Updated dependencies [a96e852]
- Updated dependencies [e02996f]
- Updated dependencies [0cc4ff3]
- Updated dependencies [a1465a6]
- Updated dependencies [d9e2711]
  - @agentlink/crypto@0.1.0
  - @agentlink/core@0.1.0
  - @agentlink/transport-nostr@0.1.0
