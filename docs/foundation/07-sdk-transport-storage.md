# 07 — SDK, Transport and Storage

All packages live in the public `agentlink` monorepo (see 09). Every package must run in **Node (LTS)**, **modern browsers** and **Cloudflare Workers** unless marked otherwise. No Node-only APIs in shared packages (use `globalThis.crypto`, `fetch`, `Uint8Array`).

---

## 1. Package map

| Package | Depends on | Exposes |
|---|---|---|
| `@4thtech-io/types` | zod | Shared types, zod schemas, constants (kinds, receipt types, fee types) |
| `@4thtech-io/log` | — | Redacting structured logger used by every package (04 §8 rule 4, I-7); secret-canary test helper (`@4thtech-io/log/testing`) |
| `@4thtech-io/crypto` | noble, hpke | Key derivation, HPKE seal/open, AES-GCM, STREAM file encryption, hashing, JCS, BIP-340 sign/verify, EIP-712 helpers; `KeyStore`, `OwnerKeyStore` and `EnvelopeKeys` interfaces (G-2, 04 §3.1.1) |
| `@4thtech-io/chain` | viem, types, crypto | Chain configs, contract ABIs, fee quotes, credits, record/receipt building, submitter client, proof verification |
| `@4thtech-io/transport-nostr` | nostr-tools, types, crypto | `Transport` implementation: relay pool, gift wrap/unwrap, subscriptions, sync cursors |
| `@4thtech-io/storage` | types, crypto | `StorageAdapter` interface; `inline`, `drop` (default, D-48) and `s3` adapters (P0); `gdrive`, `dropbox`, `onedrive` connectors (P1, M2, D-49); `ipfs-pinning` (P2); storage selection (§5.6) |
| `@4thtech-io/core` | all above | `AgentLinkClient`: identity, contacts, envelopes, threads, files, proofs, policies, approvals; `Store`, `ApprovalChannel` interfaces (the key interfaces are in crypto, G-2) |
| `@4thtech-io/node` | core | Node implementations: keychain `KeyStore` and the opt-in passphrase-locked file `KeyStore` for headless machines (§9, D-54), SQLite `Store`, local approval server (Node only) |
| `@4thtech-io/agentlink` | node, core | CLI + MCP server (stdio) (Node only). Its tool handlers live in `packages/mcp-tools` (moved there at M2-3t; imports `types`, `log`, `crypto`, `chain`, `core`), which imports no Node built-in, Node global or `@4thtech-io/node` module and nothing outside itself (06 §1, G-15, D-73 (1)); a Worker can import it |

Integrators use `@4thtech-io/core` directly (with their own `KeyStore`/`Store`) and pass their `appId` to earn integrator fees.

---

## 2. Core API (sketch)

```ts
const client = await AgentLinkClient.create({
  keyStore, store, approvals,
  transport: new NostrTransport({ relays }),
  storage: storageAdapterFromConfig(cfg),       // inline + drop (default) + optional own storage (§5.6)
  chains: defaultChains({ enabled: ["base", "gnosis"] }),
  submitters: ["https://submit.agentlink.example"], // optional; direct mode always available
  appId: ZERO_APP_ID,
});

await client.createInvite({ label, expiresInDays });
await client.acceptInvite(url);
await client.sendMessage({ to, text, type, body, replyTo, notarize });   // type: text | note | request | delivery
await client.proposeTerms({ to, terms, revises, note, notarize });       // offer; the core fills termsId, version, parties, hashes
await client.respondToTerms(envelopeId, { decision, terms, note, notarize }); // accept | reject | counter (06 §2.2a)
await client.sendFile({ to, file: { name, bytes | stream }, message, notarize, expiresInDays });
await client.syncInbox();                    // pulls from transport, stores, returns new items
await client.fetchFile(envelopeId, index);   // returns decrypted stream + metadata
await client.notarize(envelopeId, { chain });
await client.acknowledge(envelopeId, "OPENED");
await client.getProof(envelopeId);
await client.exportProofPack(envelopeId, { includeContentKey });
await AgentLinkClient.verifyProofPack(pack, { chains });   // static; no identity needed
```

**Reads for the local UI (proposed, owner confirms at merge; M1-11r-a).** Read-only accessors the local UI server uses, so its pages never reach into the store: `identity.fingerprints()` (own agent and owner fingerprints, short and long), `identity.agentAddress()` (the agent ID, the credits account for the top-up QR code), `identity.relays()` (the own relays as stored with the card), `files.resolvedFolders()` (the rules' allowed folders and their realpaths; display paths only), `proofs.list({cursor, limit})` (stored proofs, own and received, newest first), `proofs.creditsBalance()` (credits per chain, a chain that cannot be read marked unavailable) and `activity.list({cursor, limit})` (one newest-first feed of decided approvals, proofs, blocked senders and contacts, and the rules in force, from the existing tables; no new storage). Paging: `limit` 1–100 (default 20) and an opaque cursor; ties in time are ordered by a stable ID. The one non-read is `proofs.requestFaucet(chainId)`: free test credits through the runtime's `ProofsPlatform.faucet` port (M1-10b's `POST /v1/faucet`), only for a chain on the chain package's hard-coded testnet allowlist whose shipped config says testnet; any other chain, a mainnet included, is refused before anything is sent, and only the chain ID and the agent ID leave. Results carry public values only: never a key, salt, signed object, summary, sender key, transaction hash, RPC URL (§6.1) or presigned or drop URL. There is no RPC override accessor: overrides are secrets (§6.1) and no override is stored yet.

**Storage page reads (proposed, owner confirms at merge; M1-11r-c).** `files.dropUsage()` returns `{available, usedBytes, quotaBytes, remainingBytes, level, resetsAt}`: the ciphertext bytes this agent reserved on the drop in the rolling 7 days (§5.4 Limits), counted from its own sender `files` rows whose sealed locator is `drop` and whose outgoing envelope falls in the window (a deleted object still counts; an estimate, since a granted upload whose send failed leaves no row), against 1 GiB or the runtime's `DropConfig.weeklyQuotaBytes`; `level` is `within`, `near` (from 80 %; threshold owner-confirmed 23 Oct 2026) or `reached`, and `resetsAt` is when the oldest counted upload leaves the window. `ownStorage.status()` returns `none`, `ready` (with `provider` only) or `broken` (with its fixed problem code, §3.4), `configured` and `working`, and the last test result the runtime recorded with `ownStorage.recordTest({ok, code})` (fixed codes only, memory only, shown only for the storage it tested). Neither ever carries the endpoint, bucket, region, storage id, a credential or its digest, a locator, or a drop or presigned URL (I-7).

Every mutating call runs: **policy check → (approval) → action → store → result**. Policy evaluation is a pure function `evaluate(policy, action, context) → allow | approval | deny` with unit tests for every rule.

### 2.1 Commitment flow (D-55)

`respondToTerms` and `proposeTerms` (for a firm offer) follow 04 §3.4.2:

1. **Load.** The core reads the answered envelope from its store. It runs the 04 §3.4 checks: canonical form, newest version of its negotiation (key = `termsId` plus the two parties, chain computed from its own store, no forks), within `validUntil`, own agent in `parties`. It then builds the `CommitmentScope` from stored data only, with `createdAt` and `expiresAt` fixed now; the scope never changes afterwards. A new scope for the same answered envelope voids an older pending one (one live scope, 04 §3.4.2).
2. **Evaluate.** `evaluate(policy, {kind: "commitment", scope}, context)` returns one of three results:
   - `deny`: the call returns `rejected`.
   - `allow`: the core stores a policy grant with the policy document's hash. The grant is a ledger row, not authority: before each part runs, the core evaluates the verified policy again and requires `allow` for this scope.
   - `approval`: the core stores a pending approval with the scope and its digest, and the call returns `pending_approval`.
   A proof approval needed by the same call joins the same request.
3. **Run.** On the retry with `approvalId`, the core verifies the owner-signed approval against the stored scope's digest and checks the void rules. It then runs the parts that have not run yet: send the `accept`, then record it if `notarize` is set and the offer has no record, then sign the receipt if the offer's record is known. Each part is claimed atomically: in one store transaction (SQLite, or Durable Object storage) the core checks that the part is `unclaimed` (compare-and-set), sets it to `claimed` and stores the signed item (envelope, record or receipt), and only then publishes it (part states: 04 §3.4.2). A concurrent retry finds the part claimed and runs nothing. After a crash it republishes the same signed item rather than making a new one, and receivers and the contract deduplicate it by envelope ID, record nonce or one-time receipt flag. A replacement item is signed only when the chain shows the stored one can never land (04 §5).
4. **Deferred receipt.** When `syncInbox` processes a `proof` envelope (background loop or `agentlink_inbox`, never the read-only `agentlink_status`), it checks the record on-chain (M1-7g). It then looks up an open `accept` scope whose `answers.envelopeHash` equals the record's `envelopeHash`, where the record's kind is `OFFER`, its signer is the scope's `counterparty.agentId` and its recipient commitment opens to this agent. It rechecks void rules 2–6 (04 §3.4.2) and, for a grant, re-evaluates the policy. Only then does it claim the receipt part, sign `ACCEPTED` and submit it. Otherwise it signs nothing, and the activity feed says why.
5. **Expire.** At `expiresAt`, open parts are marked void and nothing more runs for that scope.

`evaluate` stays pure; the scope and grants live in the `approvals` table and the parts in `commitment_parts` (§3, §3.5).

---

## 3. Local store schema (SQLite; Durable Object uses the same schema)

| Table | Key columns |
|---|---|
| `identity` | agent_id (the agent's EVM address, 04 §2.9), agent_card_json (`enc`, below), key_epoch, storage_prefix (04 §2.9), prev_relays, prev_relays_until (§4.3), revoked_at (set only together with a `revoked_agents` row for the own agent, §3.4), created_at |
| `contacts` | contact_id, name, agent_card_json (`enc`, below), owner_fingerprint, verified, status (active / blocked / removed / revoked; `revoked` is final, §3.4; `removed` below), created_at |
| `pairings` | Staged pairings (below) |
| `invites` | invite_id, proof_key (encrypted at rest; never the raw secret, 04 §3.6), label, expires_at, used_at |
| `envelopes` | envelope_id (unique), envelope_hash, thread_id, direction, contact_id (null for a request), from_key (the sender's Nostr key), type, state (received \| ok \| request \| refused, §3.2), refused_reason, created_at, envelope_json (ciphertext; not kept for `refused`), payload_json (decrypted, optional per setting; never kept for `refused`), read_at, refused_at (the local time the row was stored as `refused`, for its retention, §3.2; D-72), request_accepted_at (set only on a `request` row the owner accepted, §3.2; D-72), delivery (outbound only: queued \| sent \| not_delivered, §3.2) |
| `files` | envelope_id, idx, name, size, sha256, locator, url, file_key (encrypted at rest with a keychain-held local key), expires_at, deleted_at, delete_after (the `files.deleteAfter` in effect at send time, M1-1g-i; null on rows stored before schema version 4, which retention keeps until expiry, and on receiver rows). Receiver rows (M1-7f-2, D-98) are written at ingest for an inbound envelope's files, with the sealed locator `{"kind":"received"}`, which names nothing to delete. Retention deletes the row, and with it the sealed file key, on both sides (04 §4) |
| `proofs` | envelope_id, chain_id, record_id, record_json (the signed Record, stored in the reserve transaction, §3.5), tx_hash, status, fee_token, fee_amount, salt (`enc`), created_at |
| `receipts` | record_id, type, signer, tx_hash, at |
| `approvals` | approval_id, action_json (`enc`: `args` can hold message text), scope_json (commitments, D-55; immutable after creation, carried in `action.context.scope`, 04 §3.4.2), answers_envelope_id, scope_key (at most one live scope per value, §3.5), source (owner \| policy grant, with the policy hash `enc`), signed_decision (the owner's `SignedOwnerAction`: an `approval.decide`, or the `approval.decideBatch` that covers this row, copied per row and re-verified for this row's `approvalId`, 04 §2.5.2, D-68; re-verified on every use, `status` is only a cache, 04 §2.5.1), signed_cancel (the owner's `approval.cancel`, if any; re-verified on use), parts in `commitment_parts` (§3.5; this replaces the earlier parts_used_json), summary (`enc`: it names the contact), status (pending \| approved \| denied \| expired \| cancelled \| void; an approval other than a commitment becomes `void` in the transaction of its one use, and a status only ever takes authority away, never grants it: proposed, owner confirms at merge, M1-7e), expires_at, created_at, decided_at |
| `policies` | The current signed policy, one row (§3.4); this replaces the earlier key, value_json, updated_at |
| `sync_cursors` | relay_url, last_seen |
| `outbox`, `outbox_staged`, `seen`, `held_envelopes`, `blocked_keys`, `rate_counters`, `publisher_lease` | Delivery (§3.2) |
| `idempotency` | Tool results by `clientRequestId` (§3.3) |
| `owner_action_nonces`, `revoked_agents`, `own_storage` | Owner authority (§3.4) |
| `budget_ledger`, `budget_state`, `commitment_parts` | Money and commitments (§3.5) |

**At rest:** all sensitive columns (decrypted payloads, contact names, file names, URLs, file keys, salts, invite proof keys, policies' parameters, stored tool results) are encrypted with a local **store key** (random, kept in the keychain, or in the file KeyStore on headless machines, §9). Non-sensitive columns (IDs, timestamps, statuses, and fee amounts, which the public record shows) stay in clear for indexing. Without the store key, the database reveals only activity timing and counts.

**Pairing and identity columns (04 §2.9, §3.6.1; proposed, G-23 and G-28; owner confirms at merge).**
- `contacts.contact_id` is the contact's agent ID, unique per store. `contacts` also holds `pairing` (`pending`, `complete` or `mismatch`), the envelope IDs of the pairing's signed `handshake` and `handshake-ack` (kept for as long as the contact exists; every display of the safety code recomputes it from them, never from a stored digest), the pending pairing data until completion (`codeCommit`, `nonceB`), and `safety_check`: the owner's signed `contact.check`, re-verified on load. `safety_code_checked` is only a cache of `safety_check`. A re-pair replaces these columns only when it completes (04 §2.9).
- `invites` also holds `nonce_a`, encrypted at rest. After pairing it is in the signed ack, as `codeReveal`.

**Cards at rest, staged pairings and removed contacts (IR-M1-7a-1 M-1, M-2, M-3; proposed, owner confirms at merge).**
- **Cards are `enc`.** `identity.agent_card_json` and `contacts.agent_card_json` hold the signed card, `{card, cardSig, cardAgentSig, cardPop}` (for `identity`, plus an optional `history`: the agent's own earlier cards, one per key epoch, oldest first, each with its signatures, so a proof pack for an envelope sent at an earlier epoch carries that epoch's card; M1-4d-f, 07 §8. Absent in a text written before M1-4d-f, re-verified on every load like the card) (D-102, 04 §2.9: the core makes both signatures for each own card, at `init`, `owner add-agent` and every `card-update`, and keeps a contact's from its `handshake`, `handshake-ack` or `card-update`; null for a contact card that arrived without them, from a peer that predates M1-4d-d), encrypted like the names. A clear card would let a stolen store file confirm guessed display names and relay lists through `nameHash` and `relaysHash`, and would expose every contact's owner keys. The card is verified again on every load. Only public lookup values stay in clear: `agent_nostr`, `nostr_keys`, `key_epoch` and `owner_fingerprint` (a hash of the owner's public keys, 04 §2.9).
- **Columns beyond the key columns** (the Store contract lists them so every implementation has them). `identity`: name and relays (`enc`, the off-chain card fields), updated_at, and pending_card_json (`enc`, null outside a rotation: the owner-signed card for key_epoch + 1, stored before the KeyStore advances; 04 §3.1.1 "Epoch advance", M1-1g-d; proposed, owner confirms at merge). `contacts`: name_source (`counterparty` or `owner`, 06 §2.1), relays (`enc`), agent_nostr (the current card's Nostr key, 64 lowercase hex, unique per store, for sender lookup), key_epoch, nostr_keys (`json`: every `agentNostr` of a stored card, oldest first, for the superseded-key rule of 04 §3.1.1 step 7 and the revoked set of §3.4), updated_at. A card-update or a re-pair keeps a name the owner chose (`name_source = owner`).
- **Key rule.** No card, from a pairing or a `card-update`, may name an `agentNostr` that is another contact's current or earlier key, a key in `revoked_agents.nostr_keys`, or the agent's own key at any epoch. Such a card is refused.
- **`pairings`** holds a verified card while its handshake runs, so that nothing in `contacts` changes before completion (04 §2.9): pairing_id (`id`, 16 random bytes, base64url), contact_id (the card's agent ID), role (`inviter` \| `invitee`), agent_nostr, key_epoch, owner_fingerprint (clear, for the re-pair and key rules), agent_card_json, name and relays (`enc`), created_at, expires_at (the invite's expiry). The re-pair, revocation and key rules are checked when it is staged and again on completion. Completion is one store transaction: the counterparty's `handshake` (for the inviter) or `handshake-ack` (for the invitee) is stored as received from the staged `agent_nostr` and processed, and the own one as sent; the contact is written with `pairing = complete`, the two envelope IDs, a new card, and the safety check cleared; and the staged row is deleted. A row is deleted on completion or abort, and pruned after expires_at. Several rows per agent ID may exist (crossed invites, 04 §2.9).
- **`removed`** is a tombstone (02 F-14). Removing a contact keeps its row and its keys, and hides it from contact lists. A later envelope from any of its keys is dropped after the signature check (04 §3.1.1 step 4) and recorded in `seen` (§3.2); it is never queued as a request or held. The row is kept until a fresh completed pairing re-activates it, under the re-pair rules of 04 §2.9 (same owner keys, epoch not lower). Blocking or removing never changes `revoked`.

**Relay columns (§4.3; G-24, accepted with D-65).**
- `identity.relays`, `contacts.relays` and `pairings.relays` (above) are `enc` `json`: the verbatim `relays` array whose hash is the `relaysHash` of the card in the same row. They are written in the store transaction that writes that card, never on their own, and are checked against the card's `relaysHash` when read. A mismatch or a value that does not open makes the row's list unreadable (§3.1, fail closed): nothing is published to that agent.
- `identity.prev_relays` (`enc` `json`) and `identity.prev_relays_until` (`int`) hold the previous list for the 30-day overlap after a relay change (§4.3), or null. Once `now` passes prev_relays_until, pruning clears both. A rotation that keeps the same list leaves both unchanged, so a compromise rotation during an overlap never overwrites the list contacts may still publish to (§4.3).

### 3.1 Conventions (G-9; proposed, owner confirms at merge)

§3.1–§3.7 add the tables that G-9 found missing and the store-side rules of G-2 (04 §3.1.1, §3.4.2, §5). They are storage-agnostic: SQLite in Node (M1-8b), SQLite storage in the Durable Object (M2-3a, 08 §3.1) and an in-memory Store for tests (M1-7a) implement the same logical schema.

- **One store per agent.** A store holds one agent (`identity`), so no table carries an agent column, and "per agent" in 04 and 06 means per store. An owner surface keeps its own, separate store (§3.6).
- **Types.**
  - `id`: text in the encoding the spec fixes for that value (04 §2.4.1), compared as bytes.
  - `int`: an integer in [0, 2^53 − 1]. Times are unix seconds.
  - `usd`: a USD amount string (04 §2.4.1), summed and compared as an exact decimal, never as a binary float.
  - `json`: the exact JSON text received or signed, never re-serialised.
  - `enc`: encrypted at rest (below).
  - An enum column holds exactly the listed values. Any other value is an inconsistency, and each table says what the core then does.
- **At rest.** An `enc` column is encrypted under the store key with AES-256-GCM through `@4thtech-io/crypto`, with AAD bound to the table, the column and the row key (M1-8b), so a value copied into another row or column does not open. A value that does not open makes the row unreadable. It is never read as empty. **Sealed form (proposed; owner confirms at merge; M1-8b, IR-M1-8b-1 L-2):** the store key is the AES-256-GCM key, each value gets a random 12-byte nonce, the AAD is JCS(`["agentlink/v1/store-column", table, column, rowKey]`) with rowKey the JSON text of the primary-key values in key order, and the stored text is `v1.` + base64url without padding of nonce ‖ ciphertext ‖ 16-byte tag.
- **Time.** The core passes `now` into every store call that compares times; the store never reads a clock. This keeps the boundaries testable, as for G-7.
- **Store transactions.** "One store transaction" means that every read and write inside it commits together or not at all, and that no other write to the same store interleaves with it (serializable). Everything it writes, including signed items and `enc` values, is prepared before it starts. Its body is synchronous: no network call, no KeyStore call, no `await`, and no encryption or decryption of an `enc` value (WebCrypto AES-GCM is asynchronous; values are encrypted before and decrypted after). Nothing is published, submitted or returned to the caller before its transaction commits. A signature made for a transaction that then does not commit is discarded, never published or submitted.
- **Fail closed.** A store error or an unreadable row never counts as absent, empty or allowed. Each table states what the core does then. Losing `seen` costs only work, and at worst a dropped item is evaluated again (§3.2).
- **Keyed digests.** A digest of low-entropy sensitive data (`idempotency.request_digest`) is an HMAC-SHA256 under an index key that `@4thtech-io/crypto` derives from the store key with HKDF (M1-8b), never a plain hash, so the file alone cannot confirm a guessed message or policy. The index key is HKDF-SHA256 of the store key with an empty salt, info `agentlink/v1/store-index` and 32 bytes of output, and a digest is written as 64 lowercase hex (proposed; owner confirms at merge; M1-8b, IR-M1-8b-1 L-2).
- **Pruning** runs in its own store transaction and deletes only rows past the retention stated for them.

### 3.2 Delivery: outbox, seen-set, held envelopes, requests and rate counters

**`outbox`**: one row per gift wrap still to deliver (one per distinct recipient Nostr key, §4.1), for the retry of §4.2, which ends at give_up_at (24 h, or earlier when the wrap would fall outside the receivers' sync look-back, G-49).

| Column | Type and meaning |
|---|---|
| wrap_id | `id`: the gift-wrap event ID, 64 lowercase hex |
| envelope_id | `id`: the outbound `envelopes` row |
| recipient_key | `id`: the recipient's Nostr x-only key, 64 lowercase hex |
| wrap_json | `json`: the signed kind 1059 event |
| relays | `enc` `json`: the relay URLs it goes to (§4.2) |
| acks | `enc` `json`: relay URL → time of its first `OK` |
| attempt | `int`: 1 for the first wrap; a later wrap of the same stored envelope for the same key gets the next number |
| role | `contact` \| `owner` (whose key recipient_key is, 04 §3.2) |
| attempts, next_attempt_at, created_at, give_up_at | `int`; give_up_at = min(created_at + 86 400, wrap_created_at + 172 800 + 300), where wrap_created_at is the `created_at` of the signed event in wrap_json (randomised up to 48 h back, NIP-59) and 172 800 + 300 is the sync look-back of §4.2 (48 h plus the skew `S`, 04 §2.5.1). The core computes it when it writes the row (G-49, D-71 (5)) |
| state | `pending` \| `sent` \| `not_delivered` |
| reason | for `not_delivered`: `timeout` \| `revoked` \| `unreadable` |

- **Keys.** wrap_id is the primary key; (envelope_id, recipient_key, attempt) is unique. At most one row per (envelope_id, recipient_key) is `pending`.
- **Transaction.** The core stores the outbound envelope and all of its outbox rows in one store transaction before the first publish. For a commitment part this is the claim transaction (§2.1, §3.5). A retry after a crash republishes the same stored event: no envelope or seal is signed again. A relay that asks for NIP-42 AUTH still gets a login signed through the KeyStore (§4.2).
- **States.** A row is `sent` once 2 relays have returned `OK` (§4.2), and `not_delivered` if that has not happened by give_up_at. `envelopes.delivery` follows the `contact` rows only: `sent` when every one is `sent`, `not_delivered` as soon as one is. The activity feed then says that the message did not reach that contact's agent. A failed `owner` row is reported separately, as an owner copy that did not arrive. Sending again is a new row with the next attempt, wrapping the same stored envelope.
- **Per-row claim (M1-7k, #99; 06 §6).** Several processes share one store, so each `pending` row has at most one publisher at a time, with no extra column:
  - **Claim.** In the store transaction that lists due rows (state `pending`, next_attempt_at ≤ now, oldest next_attempt_at first, at most 8 per listing), the process moves each listed row's next_attempt_at to now + 30 s (`OUTBOX_CLAIM_SECONDS`) with a compare-and-set on (wrap_id, state `pending`, the next_attempt_at it read). Only the rows whose compare-and-set changed one row are its own. It remembers the value it wrote as its claim. Another process does not see the row as due until the claim lapses, so a process that stalls or stops hands the row over within 30 s (the first retry interval, §4.2; longer than one publish).
  - **Re-check before publishing.** Right before publishing, the process reads the row again and goes on only if it is still `pending` and next_attempt_at still equals its claim.
  - **Recording the attempt.** acks, attempts and the next next_attempt_at are written with a compare-and-set on (state `pending`, next_attempt_at = its claim). A process that lost the claim neither publishes nor reschedules the row.
  - **Leaving `pending`.** `sent` and `not_delivered` are a compare-and-set on state `pending` only: `sent` records a fact any process may have seen (2 `OK` for the same signed event), and `not_delivered` is set right after the claim, before any publish, so neither undoes another process's progress.
- **Retention.** wrap_json is deleted when the row leaves `pending`. The row itself is deleted 7 days later.
- **At rest.** relays and acks are `enc` (URLs). wrap_json stays in clear: it is the ciphertext that relays already hold.
- **Revocation (proposed; owner confirms at merge).** The revoke transaction (§3.4) sets every `pending` row whose recipient_key is a known key of the revoked agent, at any epoch, to `not_delivered` with reason `revoked`. For the own agent it does so for every `pending` row. The activity feed reports it.
- **On failure.** If the outbox write fails, nothing is published and the call returns `error`, so the sender always holds what it sent. A row that cannot be read is marked `not_delivered` (reason `unreadable`) and reported; it is never sent to relays other than those it lists.

**`outbox_staged`** (M1-7k-b; IR-M1-7k-1 F08; schema version 3): the transient faults of a staged message, meaning a `handshake` or `handshake-ack` envelope, or a delivery `ack` (02 F-23; IR-M1-7h-1 F04 b, M1-7h-b: a processing pass signs and stages it and the delivery pass wraps and publishes it, so `syncInbox` never waits on relays for acks), that is still `queued` and has no outbox rows yet. A staged `ack` gets rows only while its contact is active and paired and its sealed payload acknowledges an `ok` inbound message from that contact; otherwise it is marked `not_delivered`.

| Column | Type and meaning |
|---|---|
| envelope_id | `id`: the staged outbound `envelopes` row; the primary key |
| failures | `int`: how many transient faults it has had |
| failed_at | `int`: unix seconds of the last one |

- **Order.** Each delivery pass gives the never-tried staged messages their rows first (oldest first), then the failed ones, least recently failed first. A failure does not use up the pass's batch. So a message whose fault does not clear never blocks a newer one, and failing messages take turns.
- **Bound (24 h).** A staged message still without rows 24 h after its created_at (`STAGED_MAX_AGE_SECONDS` = 86 400) is marked `not_delivered`, so none stays staged for good. The expiry runs first in each pass and signs nothing, so it also ends the staged messages of an agent that cannot send (revoked, or rotation unfinished).
- **Lifetime.** A row lives only while its message is staged. It is deleted in the transaction that gives the message its outbox rows, drops it or expires it; the expiry also deletes rows whose message is no longer staged.
- **At rest.** In clear (an envelope ID and times).

**`seen`**: the seen-set of §4.2.

| Column | Type and meaning |
|---|---|
| kind | `wrap` (gift-wrap event ID) \| `envelope` (the `envelopeHash`, 04 §3.1.1 step 9; never the sender-chosen envelope ID, IR-M1-5a-1 L-3, IR-M1-7b-1 Q1; confirmed by the owner, D-71 (3)) |
| id | `id` |
| first_seen_at | `int` |

- **Keys.** (kind, id) is the primary key.
- **Transaction.** The row is written in the store transaction that stores the item durably (a `received` envelope, below) or records its final outcome (held, refused or dropped), never earlier, so a crash before that never marks an unstored item as seen. A wrap that fails 04 §3.1.1 steps 1–4 is not recorded, so junk cannot grow the table; it is dropped again if a relay serves it again.
- **Retention.** A row is pruned only when it is older than 604 800 s (7 days) **and** older than the earliest `since` a sync can still request (the lowest `sync_cursors.last_seen` of the relays in use, minus 172 800 s and `S` = 300 s, 04 §2.5.1). A cursor older than 30 days, the longest relay retention (§4.2), is ignored for this bound, so a relay that never answers cannot stop pruning. **First sync after pruning (M1-5e; proposed, owner confirms at merge).** A relay with no cursor is read 9 days back (§4.3), longer than the 7-day retention, so a first sync on a new relay can offer a wrap whose `seen` row was pruned. That only costs work: core deduplicates stored envelopes by `envelope_id` and `envelopeHash` with no time cutoff (04 §3.1.1 step 9), so nothing is stored twice. The `envelope` rows hold the `envelopeHash` as `0x` + 64 lowercase hex, and the transport's `envelopeSeen` hint looks up that same key (a hint only, computed before the signature check, never a reason to skip).
- **At rest.** In clear (random IDs).
- **On failure.** A seen-set that cannot be read is treated as empty for that sync pass. For stored envelopes this only costs work, because 04 §3.1.1 step 9 deduplicates against every stored envelope with no retention cutoff. An item that was dropped (rate limit, `unknownSenders: drop`, a cap, a blocked contact) may be evaluated again and then delivered late. That is a late delivery of an authentic message, never a forgery.

**Received, not yet processed (`envelopes.state = received`; proposed, owner confirms at merge).** `agentlink_status` and the sync loop only fetch and store (06 §2.0, §6). An envelope that passed 04 §3.1.1 steps 1–4 is stored as `received`, with its seen row, in one store transaction. Processing (steps 5–9 and the effects: a `card-update` applied, a pairing completed, held rows run again, a deferred receipt) moves it to `ok`, `request`, `refused`, a held row, or deletes it when it is dropped, in one store transaction with those effects. A crash in between leaves it `received`, and the next pass processes it. **A terms offer that waits for a link** (04 §3.4; proposed, owner confirms at merge; M1-32-b, IR-M1-32-b-1 F02) stays `received`, marked `refused_reason = terms_waiting`, holds no payload in clear, and is decided again on each pass in link order. It is not an unread item: `agentlink_status` and the inbox counts leave it out. It counts against its contact's rate limit (the waiting rows of `admitTx`) and towards the 1 000 `received` rows. It is refused with `terms_refused` once its signed `createdAt` is more than 172 800 s old; the step 9 skew check runs again on every pass. An envelope whose ID is already stored, at any state, with another envelope_hash is a step 9 refusal (the contact is flagged), never an insert error. Each pass takes `card-update` rows first (04 §3.1.1, step 7). At most 1 000 rows are `received`. Above that, a new item is neither stored nor marked as seen, and a later sync fetches it again within the 48 h look-back.

**`held_envelopes`**: envelopes held by the arrival-order rule (04 §3.1.1, step 7; G-2).

| Column | Type and meaning |
|---|---|
| envelope_id | `id` |
| envelope_hash | `id`: `0x` + 64 lowercase hex |
| from_key | `id`: the unknown sender key |
| owner_kid | `id`: the `kid` of the stored contact's `ownerEnc` that the recipients include |
| envelope_json | `json`: the envelope as received (ciphertext) |
| payload_json | `enc` `json`: the payload that passed steps 5 and 6 |
| received_at, release_at | `int`; release_at = received_at + 172 800 (48 h) |

- **Keys.** envelope_id is the primary key. Step 9 (freshness and uniqueness) covers held rows as it covers stored envelopes, so an envelope ID is unique across `held_envelopes` and `envelopes`.
- **Cap.** At most 100 rows per owner_kid (proposed with D-62; owner confirms at merge). The insert, the count and the deletion of the oldest row (lowest received_at, then lowest envelope_id) run in one store transaction, so the cap holds under concurrent sync.
- **Own pool.** Held rows have their own pool of 100 per owner_kid and do not count toward the requests-queue limits (below), so a stranger that copies a contact owner's `kid` delays only held rows and cannot fill the queue (proposed; owner confirms at merge; amends D-62, 04 §3.1.1 step 7).
- **Release.** Each time a `card-update` is applied, the core re-screens the held rows whose owner_kid belongs to that contact's owner. It also re-screens every held row at the start of each processing pass, so a crash after the `card-update` never leaves a row waiting. A row whose `from` is now a contact's current key or a blocked, removed or revoked key, or that is due (release_at), runs again **from step 5** (04 §3.1.1, step 7: one new `unwrapCek` each, since a held row keeps no CEK, so the step 8 wrap check runs against the new card); the rest stay held, with no `unwrapCek`. At release_at, a row that no `card-update` claimed runs again from step 5 and, unless a later step refuses it, goes to the requests queue, after the `from` re-check of 04 §3.1.1. A row is deleted only in the store transaction that stores its outcome: the contact's envelope, a request or a refused envelope.
- **Retention.** Until release_at, or until the row is dropped by the cap.
- **At rest.** payload_json is `enc`; the other columns are in clear.
- **On failure.** If the held set cannot be read or written, the envelope is not processed and not marked as seen; a later sync fetches it again within the 48 h look-back. It is never processed as the contact's and never shown as a request.

**Requests queue.** A request from an unknown sender (02 F-65, 06 §3 `unknownSenders: queue`) is an `envelopes` row with `state = request`, `contact_id` null and `from_key` set. **Limits (proposed; owner confirms at merge):** at most 5 pending requests per unknown sender key and 200 in total. When a limit is reached, a new request is refused: it is not stored, and its seen row records the outcome. Nothing is sent to the sender: a notice would amplify a flood from many fresh keys, show that the agent is live, and could not meet the recipient rules (04 §3.2). Only the owner is told, by one aggregated activity line (for example, 12 requests were refused because the queue is full). The same limits count unexpired `refused` rows from unknown keys (04 §3.1.1 steps 5 and 8; retention below). Held envelopes use their own pool (above), outside these limits (amends D-62; owner confirms at merge). The count and the insert run in one store transaction. A request from a key in `revoked_agents.nostr_keys` is dropped (§3.4).

**What the owner does with a request (D-72; IR-M1-7e-1 F01; proposed, owner confirms at merge).** Only on owner surfaces (the local UI, the desktop app and the owner's own terminal, 06 §8; the console from M2), never through an MCP tool (I-4). None of these creates a contact: a contact comes only from a completed pairing (04 §2.9). Each runs in one store transaction.
- **Accept** sets `request_accepted_at` on that one `request` row; nothing else changes. `agentlink_inbox` then returns it, always inside the untrusted block with the unknown-sender label, and with a fixed `nextStep` that offers the user an invite to share with the sender (06 §2.1, §4). It stays a `request` row: it keeps counting toward the limits above until the owner ignores it, and the agent cannot reply to it (04 §3.2). The flag covers that row only; a later envelope from the key is a new request.
- **Ignore** deletes every `request` and `refused` row whose `from_key` is that key and whose `contact_id` is null. **Ignore all** deletes every such row for every key, so the owner can always empty the queue at once, whatever the number of sender keys.
- **Block** inserts the key into `blocked_keys` and deletes its `request`, `refused` (with `contact_id` null) and `held_envelopes` rows. From then on its envelopes are dropped at 04 §3.1.1 step 5, before any HPKE open, and use no queue space. **Unblock** deletes the `blocked_keys` row; nothing removed comes back, and a dropped envelope is not fetched again (its seen row stays). A request whose key has meanwhile become a contact's current key is not blocked: Block changes nothing and the surface offers Ignore, because the contact's status governs that key (IR-M1-7e-2-1 F03; proposed, owner confirms at merge).
- The seen rows of deleted rows stay, so a relay that serves the same item again does not bring it back (seen-set retention above).

**Refused-row retention (D-72; IR-M1-7e-1 F01; proposed, owner confirms at merge).** A `refused` row with `contact_id` null (a refusal from an unknown key) expires 604 800 s (7 days) after `refused_at`, the local time it was stored. It is measured on the local clock, never from the sender-chosen `createdAt`, which step 9 has not yet checked when step 8 refuses. An expired row no longer counts toward the limits, the count ignores it in the same transaction as the insert, so expiry never waits for pruning, and pruning deletes it at the start of each processing pass. *Why 7 days:* it is the seen-set's minimum retention (above). While the refused row exists, step 9 deduplicates a re-served envelope against it; after that, the seen row does so for as long as a sync can still request the item. A re-count after both are gone gives a sender nothing that a fresh key does not, and a refusal from an unknown key flags no contact (IR-D-72-1 F04). And a refused row holds no ciphertext and no payload, so after a week it serves only the count. A flood of refusals from fresh keys can therefore fill the queue for at most 7 days, and the owner can empty it at once with Ignore all. Refused rows of a contact (`contact_id` set) are not affected: they stay as the contact's record, as before.

**`blocked_keys`** (D-72; proposed, owner confirms at merge).

| Column | Type and meaning |
|---|---|
| from_key | `id`: the blocked sender key (64 lowercase hex) |
| blocked_at | `int` |
| via_envelope_id | `id`: the request the owner blocked it from, the handle for Unblock |

- **Keys.** from_key is the primary key.
- **Writes.** Only the owner's Block and Unblock. A `card-update` that passes 04 §3.4.1 and makes a blocked key a contact's current key deletes its row in the same transaction: from then on the contact's status governs that key. Nothing else adds or removes a row.
- **A contact's rotation comes first (IR-D-72-1 F01).** The 04 §3.1.1 step 5 drop skips, on its first run, an envelope that step 7 would hold (its recipients include the `kid` of a stored contact's `ownerEnc`). A contact's `card-update` from a blocked new epoch key is therefore applied, and the rule above removes the block. Once the payload type is known (04 §3.1.1 step 6), an envelope from a blocked key that skipped the drop is dropped unless it is (a) held for a contact's key change or (b) a contact's `card-update`; a pairing `handshake` or `handshake-ack` from a blocked key is always dropped (IR-D-72-1 F10). Other envelopes from the key are held and, if still unclaimed and blocked when due, dropped on their re-run from step 5, never queued as requests.
- **Retention.** Until Unblock, with no cap: only the owner adds rows, one deliberate action at a time. Blocking is not the defence against fresh keys; the limits, the refused-row retention and Ignore all are.
- **At rest.** In clear (public keys), like `from_key` in `envelopes`.
- **On failure.** If the set cannot be read, the processing pass stops and processes nothing, so a blocked key's envelope is never stored as a request; a later pass runs it again.

**`rate_counters`**: inbound envelopes per contact, for `contacts.rateLimitPerContactPerHour` (06 §3; M1-7h).

| Column | Type and meaning |
|---|---|
| contact_id | `id`: the contact's agent ID |
| bucket | `int`: the start of a 60-second bucket, t − (t mod 60) |
| count | `int` |

- **Keys.** (contact_id, bucket) is the primary key.
- **Window.** The hour is the buckets with bucket > now − 3 600: a sliding hour at one-minute resolution, so no double burst is possible at the top of the hour (as for the daily budget, G-7).
- **Transaction.** The core reads the window sum and increments the bucket in the store transaction that stores the contact's envelope, including a `refused` one (from a superseded key, or without the own owner's entry, 04 §3.1.1 steps 7 and 8), so refused envelopes cannot grow without bound either.
- **Over the limit (proposed; owner confirms at merge).** An envelope that would go above the limit is dropped: it is not stored, its seen row records the outcome, and the activity feed shows one line per contact and hour with the count (for example, 37 messages from a contact were dropped), with the option to block the contact.
- **Retention.** Buckets with bucket ≤ now − 3 600 are deleted.
- **At rest.** In clear (IDs and counts).
- **On failure.** A counter that cannot be read counts as being at the limit for that contact. Other contacts are not affected.

**`publisher_lease`**: which process of an agent keeps the relay subscriptions and runs the background loop (06 §6; D-73, derived; proposed, owner confirms at merge; M1-9r).

| Column | Type and meaning |
|---|---|
| name | text: the lease, `subscriptions` (the only value in M1) |
| holder | `id`: 16 random bytes, base64url, chosen by each server process at start |
| lease_until | `int`: unix seconds |

- **Keys.** name is the primary key; the store holds one agent, so there is one row.
- **Take.** In one store transaction a process inserts the row with its holder and lease_until = now + 60, or replaces a row whose lease_until ≤ now with a compare-and-set on the old holder. A process whose take changes no row is not the holder and tries again 20 s later.
- **Renew.** The holder sets lease_until = now + 60 every 20 s, with a compare-and-set on holder = its own. If that changes no row, it has lost the lease: it closes its subscriptions and stops the loop before doing anything else.
- **Release.** On clean shutdown the holder deletes the row with a compare-and-set on holder = its own.
- **Lapse (M1-7k-b; IR-M1-7k-b-1 L-1).** A lease is lapsed when lease_until ≤ now, or when lease_until > now + 120 (two lease periods). No holder writes more than now + 60, so the second case can only come from a clock that has since gone back by more than 60 s. So a holder that crashed just before a backward clock jump cannot keep the lease for the length of the jump: after a crash it lapses within 120 s whatever the clock does. A smaller step back (an NTP correction) changes nothing. A process counts itself as holder only while now < lease_until ≤ now + 120 on the same clock; every process of one agent runs on one machine and reads the same clock (06 §6). After a jump back by more than 60 s and then forward again, an old holder can still believe it holds the lease until its next renewal, which changes no row: at most one renewal interval (20 s). The lease is not authority (below), so this costs relay connections only.
- **Users (M1-9r).** The MCP server's background loop (`agentlink mcp`; 06 §6) is the only user: one active publisher per agent. Only the holder runs the loop's passes (inbox sync, then outbox delivery). A process that does not hold the lease stays idle and tries again every 20 s; its tools still work, and `agentlink_inbox` and `agentlink_status` run their own short catch-up. CLI commands never start a loop and never take the lease. Until live relay subscriptions land (M1-9s), the holder polls its relays with a repeated catch-up pass every 30 s, sooner after a partial pass (1 s, doubling with each consecutive partial pass up to 30 s, reset by a full pass).
- **At rest.** In clear (a random ID and a time).
- **On failure.** A lease that cannot be read or written counts as not held: the process keeps no subscriptions, and its tools still work (06 §6).
- **Not authority.** The lease decides only who keeps relay connections. Every effect is still idempotent and claimed per row (outbox claim, M1-7k; idempotency lease, §3.3), so two holders at once cost connections, never a second effect.

### 3.3 Idempotency results (06 §1 rule 6)

**`idempotency`**: the original result of each mutating tool call made with a `clientRequestId`.

| Column | Type and meaning |
|---|---|
| tool | text: the MCP tool name (06 §2.0) |
| client_request_id | text: the caller's value, compared as bytes; its bounds come from the MCP tool input schemas (M1-9c) |
| approval_id | `id`: the call's `approvalId`, or the empty string |
| request_digest | `id`: HMAC-SHA256 under the index key (§3.1) of JCS(args), as 64 lowercase hex, with `args` formed as for `action.args` (04 §3.4.1: defaults applied, without `approvalId` and `clientRequestId`, paths resolved with realpath) |
| state | `running` \| `done` |
| run_id | `id`: 16 random bytes, base64url, chosen by each execution |
| lease_until | `int`: the running execution's lease |
| effect_ref | `enc` `json`: the IDs of the durable effects the call made (envelope IDs, record IDs, approval ID, ledger entry IDs) |
| result_json | `enc` `json`: the original tool result |
| created_at, expires_at | `int`; expires_at = max(created_at + 604 800, the `expiresAt` of the call's approval or commitment scope + `S`), with `S` = 300 s (04 §2.5.1) |

- **Keys.** (tool, client_request_id, approval_id) is the primary key. A retry with an `approvalId`, after a `pending_approval`, is a new call.
- **Execution lease (IR-G-9-1 H-1; proposed, owner confirms at merge).** Each execution picks a fresh run_id. Its lease lasts 60 s and the execution renews it every 20 s with a compare-and-set on (state `running`, run_id = its own).
- **Start.** In one store transaction the core reads the row:
  - no row: it inserts one as `running` with its run_id and lease_until = now + 60;
  - `done` with the same request_digest: it returns result_json (but see stale approvals below) and runs nothing;
  - `running` with lease_until > now: the call runs nothing and returns `error` with a next step to try again (in progress);
  - `running` with lease_until ≤ now: the execution takes the row over with a compare-and-set that replaces the old run_id with its own, and then resumes (below).
- **Effects outside the store.** A side effect made before the first effect transaction, such as a file upload to the drop or own storage, can repeat after a takeover with no effect_ref. The result is an orphaned ciphertext object that expires (04 §4), never a second envelope or charge. This residual is accepted.
- **Effects.** Every store transaction that makes a durable effect for the call (an envelope with its outbox rows, a signed Record with its ledger reservation, a part claim, a pending approval) includes a compare-and-set on the idempotency row: state `running`, run_id = its own, lease_until > now. It appends the effect to effect_ref. If that compare-and-set changes no row, the whole transaction aborts: no effect is written, prepared signatures are discarded (§3.1), and the call returns the in-progress `error`. So two executions can never both make an effect, whatever the clocks or the lease timing; the lease decides only who may proceed.
- **Resume.** A takeover never runs the call again blindly. With effect_ref present, it re-checks each stored effect and finishes from there: republish `pending` outbox rows, resubmit the stored signed Record (or settle it from what the chain shows, 04 §5), report the stored pending approval or the part states. With no effect_ref, nothing durable was made, so the call runs from the start.
- **Finish.** One store transaction sets state `done` and stores result_json, with the same compare-and-set. If it changes no row, the execution returns its result without storing it, and the execution that holds the lease stores its own.
- **Fail closed.** Any doubt (the row cannot be read, a compare-and-set fails, the lease cannot be renewed) means the call runs nothing more and returns `error`. A repeat never makes a second effect.
- **Which results are kept** (proposed; owner confirms at merge). A call that ends in `error`, `needs_setup` or `needs_credits` without any durable effect deletes its row (with the same compare-and-set), so a retry runs once the cause is fixed. Every other result is kept and returned to repeats.
- **Stale approvals.** A kept `pending_approval` result whose approval is no longer pending is not replayed: a repeat gets the approval's current state, as `agentlink_get_approval` reports it (06 §2.5), so the agent does not loop.
- **Same key, different request_digest (proposed; owner confirms at merge).** The call runs nothing and returns `rejected` with code `IDEMPOTENCY_KEY_REUSED`, with no data from the original result. A different request is not a repeat (06 §1 rule 6).
- **Retention.** Pruned after expires_at (proposed; owner confirms at merge): at least 7 days, longer than the 24 h approval TTL, and never before the call's approval or scope has expired.
- **At rest.** effect_ref and result_json are `enc` (summaries name contacts). The key columns, the keyed request_digest, state, run_id and times stay in clear.
- **On failure.** If the row cannot be read or written, the call runs nothing and returns `error`, so a repeat never sends twice.

### 3.4 Owner authority: nonces, signed objects and revocation

**`owner_action_nonces`** (04 §2.5.1).

| Column | Type and meaning |
|---|---|
| nonce | `id`: 16 bytes, base64url without padding |
| op | text: the `op` of the applied action |
| action_hash | `id`: sha256(JCS(SignedOwnerAction)), 64 lowercase hex |
| issued_at, expires_at, applied_at | `int` |

- **Keys.** nonce is the primary key, so a second apply of the same object fails on the key and rolls back.
- **Transaction.** The nonce check, the insert and the action's effects (the approval decision, the policy row, the safety-code check) are one store transaction (04 §2.5.1). A refused object writes nothing. `agent.revoke` is exempt and writes `revoked_agents` instead.
- **Retention.** At least 2 592 000 s (30 days, `NONCE_RETENTION_SECONDS`) after applied_at.
- **At rest.** In clear.
- **On failure.** If the table cannot be read, every owner action except `agent.revoke` is refused and reported ("not applied, sign again", 04 §2.5.1).

**Stored signed objects.** Each is kept as the exact `SignedOwnerAction` JSON that was applied and is verified again when used (04 §2.5.1). A column derived from it is only a cache.
- **`policies`**: exactly one row: version (`int`, in clear), signed_json (`enc`: the `policy.set`, whose parameters are sensitive), policy_hash (`enc`: sha256(JCS(policy)), the hash that grant rows name; encrypted because a policy can be guessed), applied_at.
  - **Apply.** The core reads the KeyStore mark first. One store transaction then checks the nonce and that `version` is above both the stored row's version and the mark, inserts the nonce and replaces the row. After it commits, the core raises the policy-version high-water mark, which lives in the KeyStore and not in the store (04 §2.5.1, §2.2, §2.8). The store always commits first (proposed; owner confirms at merge). The mark only ever increases: it is set to max(current mark, `version`): the raise reads, compares, writes and reads the item back under the inter-process lock (06 §6), so two processes cannot lower it; a load reads the item without the lock (IR-M1-8g-1 F-1). On Node it is the KeyStore item `policy-version` (04 §2.2, §2.8); the raise reads it back, and a malformed item is never read as 0 (proposed; owner confirms at merge; M1-8g). In the Durable Object, where the mark lives is fixed in M2-3a. If raising it fails, the stored version and the mark differ and the G-6 rules apply (06 §3), and this is reported, until the owner signs a newer `policy.set`.
  - **Load.** signed_json must verify and its version must equal the mark (06 §3). A missing, unreadable or failing row is handled by G-6. A mismatch is never repaired from the stored row.
  - **Broken ledger.** When `budget_state.status` is `broken`, the apply transaction also starts a fresh ledger (§3.5).
- **`approvals`**: signed_decision (`approval.decide`, or the covering `approval.decideBatch`, never for a commitment, 04 §2.5.2) and signed_cancel (`approval.cancel`), each verified again before use (04 §2.5.1, §3.4.2).
- **`contacts.safety_check`**: the `contact.check` (§3, pairing columns).

**`own_storage`** (M1-9i, D-115): the agent's own S3-compatible storage (§5.2), as the owner signed it.

| Column | Type and meaning |
|---|---|
| id | `id`: the `storage.set` `id`, 16 lowercase hex; it names the KeyStore item `s3:<id>` (04 §2.2) |
| signed_json | `enc`: the applied `storage.set` (04 §2.5.1), verbatim; encrypted because the endpoint and bucket identify the user's account |
| applied_at | `int` |

- **Rows.** At most one in M1. A newer `storage.set` replaces it; `storage.remove` deletes it.
- **Transaction.** The nonce check, the nonce insert and the upsert (`storage.set`) or delete (`storage.remove`) are one store transaction (04 §2.5.1). `backup.export` writes only its nonce row, which is the audit record (04 §2.3.3).
- **Anti-rollback.** After the commit, the core sets the KeyStore item `storage-mark` (04 §2.2) under the inter-process lock (06 §6) and reads it back. The store commits first, as for `policies`.
- **Load** (`ownStorage.load()`): a missing `storage-mark` item (an agent created before M1-9i) reads as `active: null`, a malformed one as `broken` (04 §2.2). `none` when there is no row and `storage-mark` names no active `id`; `ready` when the row's `storage.set` verifies (encoding, `sig`, `agent`, `owner`, schema; never expiry), its `id` equals `active` in `storage-mark`, and the item `s3:<id>` exists with a matching `credentialDigest`; `broken` otherwise: a row that does not verify, a missing or mismatched item, a row with `active` = `null`, no row while `active` is set, or a malformed mark. A mismatch is never repaired from the stored row.
- **At rest.** signed_json `enc`; id and applied_at in clear. No credential is ever in the store.
- **On failure.** `broken`, never the drop (§5.6).

**`revoked_agents`**: the revoked-agent set (04 §3.4.1, D-58), for contacts and the own agent.

| Column | Type and meaning |
|---|---|
| agent_evm | `id`: `0x` + 40 lowercase hex |
| nostr_keys | `json`: every `agentNostr` key of that agent known from stored cards, at any epoch |
| signed_json | `json`: the applied `agent.revoke`; null when only the Registry shows the revocation |
| reason | `compromised` \| `retired` \| `other` \| null |
| source | `envelope` \| `registry` (05 §4; either one counts, 04 §3.4.1) |
| chain_id, registry_ref | `id`, set only for `registry` |
| applied_at | `int` |

- **Keys.** agent_evm is the primary key; a re-published copy is a no-op.
- **Transaction.** One store transaction inserts the row, sets `contacts.status` to `revoked` (or `identity.revoked_at` for the own agent) voids every pending approval and every open commitment part with that agent as counterparty (void rule 3, 04 §3.4.2) and stops its `pending` outbox rows (§3.2). From then on the core processes no envelope from that agent ID or from a key in nostr_keys, including a request after the contact was removed, and refuses its `card-update` and `handshake`. For the own agent, the core stops sending and signing.
- **Revoked means either.** An agent is revoked if it has a `revoked_agents` row **or** its contact status is `revoked`. Editing one of the two does not reverse a revocation. A same-OS-user process that edits both is the G-1 residual.
- **Retention.** Permanent. A row is never deleted, not even when the contact is removed, so a re-pair under that agent ID is refused (04 §2.9, M1-7a).
- **At rest.** In clear: agent IDs are already in clear, and the object holds no secret.
- **On failure.** If the set cannot be read, the core processes no inbound envelope, and sends or signs nothing for any counterparty, until it can. A stored signed_json that no longer verifies still counts as revoked and is reported.

**Contact status `revoked`.** It is set only together with a `revoked_agents` row and is never changed back to `active` or `blocked`. The contact's history stays readable (04 §3.4.1).

### 3.5 Money and commitments: budget ledger and commitment parts

**`budget_ledger`**: the daily budget window of 06 §3 (G-7).

| Column | Type and meaning |
|---|---|
| entry_id | `id`: 16 random bytes, base64url |
| ledger_epoch | `int` |
| t | `int`: the time of the paid action; for a replacement, the time it was reserved |
| record_id | `id`: the Record's `recordId`, `0x` + 64 lowercase hex |
| chain_id | `int` |
| approval_id | `id` or null |
| reserved_usd | `usd`: the Record's `maxFee`, valued 1:1 in USD (D-46) |
| charged_usd | `usd`: set when charged |
| state | `reserved` \| `charged` \| `released` |
| deadline | `int`: the Record's `deadline` |
| replaces | `id`: the entry_id of the Record this one replaces (04 §5), or null |
| settled_at | `int` or null |

**`budget_state`**: exactly one row, created with `identity`: ledger_epoch (`int`), status (`ok` \| `broken`), newest_t (`int`: the highest t written in the current epoch), since (`int`: when the current epoch started), broken_at (`int` or null).

- **Keys.** entry_id is the primary key; record_id is unique, so one signed Record has one entry.
- **Spent.** The exact sum of reserved_usd over `reserved` rows and charged_usd over `charged` rows, for the current ledger_epoch and t > now − 86 400.
- **Check and reserve.** The core signs the Record before the transaction (a prepared item, §3.1). One store transaction then reads `budget_state`, the window and `policies.version`, runs `evaluate`, inserts the `reserved` row, raises newest_t and stores the signed Record (`proofs.record_json`) with its salt (`proofs.salt`, `enc`), and the idempotency effect (§3.3). Only after the commit does the core submit (06 §3). After a crash, only that stored Record is ever resubmitted, and a replacement follows 04 §5. If the transaction does not commit, the signed Record is discarded. For a commitment, this is the part's claim transaction (§2.1, below).
- **Policy version pinned.** If `policies.version` inside the transaction differs from the version that `evaluate` used, the transaction aborts, and the core reloads and verifies the policy and tries again. The same check runs in every part claim (below). A `policy.set` applied by another process is therefore never bypassed by a stale evaluation.
- **Settle and release.** On confirmation the row becomes `charged` with charged_usd. It becomes `released` only under the 04 §5 condition (deadline passed and no record at the `finalized` block), never on a failed submission alone.
- **Replacement (04 §5, D-62).** One store transaction marks the earlier row `released`, inserts the replacement's `reserved` row with `replaces` set, and replaces the stored item of its commitment part, if any, so the window never counts both.
- **Broken ledger.** Any of these makes the ledger broken: a state outside the enum, an amount that is not a USD amount, a `charged` row without charged_usd, a ledger_epoch above the one in `budget_state`, a missing `budget_state` row, now < newest_t, or a read error. The core then sets status `broken`, in its own transaction where it can, and treats the ledger as broken even when it cannot write. Every paid action then needs the owner's approval (06 §3). The next applied `policy.set` (owner presence) starts a fresh ledger in its own apply transaction (§3.4): ledger_epoch + 1, status `ok`, newest_t = now, since = now, broken_at = null. The clock check then compares only with the new epoch's newest_t, so a clock that was once set forward cannot keep the ledger broken. Rows from earlier epochs stay for settlement and display but no longer count.
- **Retention.** A row is never pruned while `reserved`. A settled row is pruned no earlier than 86 400 s after its t; the local UI may keep it longer for history. newest_t keeps the clock check valid after pruning.
- **At rest.** In clear: IDs, times, states and fee amounts, which the public record shows once charged.
- **On failure.** As for a broken ledger. A broken ledger never counts as an empty sum (06 §3).

**`commitment_parts`**: the part states of a commitment scope (04 §3.4.2, D-62). They replace the earlier parts_used_json.

| Column | Type and meaning |
|---|---|
| approval_id | `id`: the `approvals` row |
| part | `envelope` (the `accept` or firm-offer envelope) \| `record` \| `receipt` |
| state | `unclaimed` \| `claimed` \| `done` \| `void` |
| item_ref | `id`: the envelope ID, the `recordId`, or the `recordId` with the receipt type |
| item_json | `json`: the stored signed item (envelope, signed Record or signed Receipt) |
| ledger_entry_id | `id`: for a `record` part, its `budget_ledger` row |
| void_reason | `expired` (`TERMS_EXPIRED`) \| `superseded` (`TERMS_SUPERSEDED`) \| `void` (`APPROVAL_VOID`, rules 2–4) \| `cancelled` (`APPROVAL_VOID`, rule 6), or null |
| replacements | `int`: how many times the item was replaced (04 §5) |
| claimed_at, done_at, updated_at | `int` |

- **Keys.** (approval_id, part) is the primary key. The rows are created with the scope, one per part that the 04 §3.4.2 table allows for its decision, all `unclaimed`.
- **One live scope.** `approvals.scope_key` is `answers.envelopeId` for an answer, and the negotiation key with `version` for a firm offer (04 §3.4.2). Per scope_key, at most one approval is pending, and at most one is approved with a part still `unclaimed`. The store transaction that creates a pending scope voids an older pending one (04 §3.4.2). An older approved scope keeps its parts while the new one is pending: the transaction that applies the owner's approval of the new scope voids the older scope's `unclaimed` parts, so only an owner signature ends what an owner approved (proposed; owner confirms at merge). A part is claimed only if no other scope with the same scope_key has that part `claimed` or `done`, checked in the claim transaction.
- **Claim.** One store transaction changes the part from `unclaimed` to `claimed` as a compare-and-set (an update that must change exactly one row), stores item_json and writes the item's own rows: the `envelopes` row and its `outbox` rows for an `envelope` part (§3.2), or the signed Record, its salt and the `reserved` ledger row for a `record` part (as in check and reserve, including the `policies.version` check). Only after it commits does the core publish or submit (§2.1).
- **Done and void.** An `envelope` part is `done` when its outbox rows are `sent`. If they become `not_delivered`, it stays `claimed`, and only the same stored envelope may be published again. A `record` or `receipt` part is `done` when the chain shows its item or the identical one (05 §3.3). `unclaimed` or `claimed` becomes `void` when the scope expires or a void rule applies; `done` and `void` are final. A voided `record` part keeps its ledger row `reserved` until 04 §5 releases it, because a signed Record may still land.
- **Replacement.** While the part is `claimed`, one store transaction replaces item_json and item_ref, moves the ledger reservation as above and increments replacements. The part stays `claimed`.
- **Retention.** Kept with the `approvals` row.
- **At rest.** item_json stays in clear: an envelope is ciphertext, and a Record or Receipt holds no salt (the salt stays in `proofs`, encrypted).
- **On failure.** If the part cannot be read, or the compare-and-set changes no row, nothing is published, submitted or charged. The call returns the state it can read, or `error`.

### 3.6 Owner surfaces: owner copies

The console and the desktop app keep the owner's own store, never an agent's. They use these logical tables; the console's storage engine is chosen with its read session (M2-2d).

**`owner_copies`** (04 §3.1.1, I-9).

| Column | Type and meaning |
|---|---|
| envelope_id, envelope_hash | `id` |
| agent_id | `id`: the owner's agent the copy is placed on, or null |
| placement | `sent` \| `received` \| `conflict` \| `unattributed` |
| type, from_key, created_at, received_at | as in `envelopes` |
| envelope_json | `json`: ciphertext as received |
| payload_json | `enc` `json`: the decrypted payload, under the surface's own store key |

- **Keys.** (envelope_id, envelope_hash) is the primary key. A second copy with the same envelope_id and another hash is inserted, and in the same store transaction both rows become `conflict` and the contact is flagged (04 §3.1.1).
- **Placement** follows 04 §3.1.1 and is computed from the owner's own copies of `handshake`, `handshake-ack` and `card-update`. If those cannot be read, the copy is `unattributed` (fail closed).
- **Retention.** Pairing and `card-update` copies are kept for as long as the agent exists, because they are the source of revoke recipients (04 §3.4.1). Other copies follow the surface's own rules (08).
- **Never stored:** owner keys (04 §3.1.1).

**`owner_policy_echo`**: agent_id → the highest `version` seen in a verified `policy` echo. It is never lowered (04 §3.4.1).

**`owner_agents`**: the surface's authenticated relay list for each of its agents (§4.3; G-24, accepted with D-65).

| Column | Type and meaning |
|---|---|
| agent_id | `id`: the agent's EVM address (04 §2.9) |
| card_json, card_sig | `json`: the agent's current card and its `cardSig`, as received or signed |
| key_epoch | `int`: the card's `keyEpoch` |
| relays | `enc` `json`: the verbatim list matching the card's `relaysHash` |
| prev_relays, prev_relays_until | `enc` `json` and `int`: the previous list and the end of its 30-day overlap, or null |
| source | `signed` \| `copy` \| `link`: this surface signed the card, an owner copy carried it, or the owner link (M2-2c) did |
| revoked_at | `int` or null; the list stays in the union for 30 days after it, then serves only revoke re-publishing |

- **Keys.** agent_id is the primary key. A row is replaced only by a card with a strictly greater key_epoch for the same agent_id, as a compare-and-set in one store transaction that also moves the old list to prev_relays. If prev_relays is still within its overlap, it becomes the union of both previous lists (at most 16 relays) with the later end time (§4.3).
- **Checks on write and on read.** `cardSig` recovers to the surface's own `ownerEvm`, the card's `ownerNostr` and `ownerEnc` are the surface's own, and relays hashes to the card's `relaysHash`. A row that fails a check or does not open is not used, and the agent is shown as possibly incomplete (§4.3). It is never deleted for that reason.
- **The bootstrap set** is a release constant plus the owner's own Settings entries, kept `enc` in the surface's settings and never published.
- **`sync_cursors`** in the owner store work as in the agent's store, one per relay of the union.

### 3.7 What the Store interface needs

- **One logical schema** with the tables, keys and unique constraints above, enforced by the storage itself and not only by the core.
- **`transaction(fn)`** with a synchronous body, serializable and all-or-nothing across tables (§3.1).
  - Node: a `better-sqlite3` transaction with `BEGIN IMMEDIATE`, in WAL mode under the inter-process file lock (06 §6), so harnesses that share one agent serialise their writes.
  - Durable Object: `ctx.storage.transactionSync` on its SQLite storage; no transaction spans an `await`.
  - In memory (tests): a single lock with the same all-or-nothing behaviour.
- **Compare-and-set** as an update that reports how many rows it changed.
- **`now` passed in**, and a pruning operation per table with its retention.
- **Forward migrations only.** A store whose schema version is newer than the code refuses to open (fail closed) and is never downgraded.
  - Schema version 3 (M1-7k-b) adds `publisher_lease` (§3.2) and `outbox_staged` (§3.2).
  - Schema version 4 (M1-1g-i) adds the nullable `files.delete_after` (§3); `STORE_SCHEMA_VERSION` is 4 and the Node store migrates forward from versions 1, 2 and 3.
- **Core-enforced rules** (IR-M1-7a-1 L-5; proposed, owner confirms at merge). These span rows or tables, so the core enforces them inside its store transactions; a SQLite store may add triggers as a second layer: an envelope ID unique across `envelopes` and `held_envelopes` (§3.2); at most one approved scope with a part still `unclaimed` per scope_key (§3.5); `revoked_agents` never deleted and contact status `revoked` final (§3.4); the contact key rule (§3); and pruning per table with its retention.
- **Proposed values for the owner to confirm at merge (G-9):** the held-envelope cap and its own pool (§3.2, amends D-62); the requests-queue limits, with refusals shown only to the owner (§3.2); the owner's accept, ignore, ignore all and block, the refused-row retention of 7 days and `blocked_keys` (§3.2, D-72); dropping envelopes over `rateLimitPerContactPerHour` (§3.2); `IDEMPOTENCY_KEY_REUSED` for a reused `clientRequestId` (§3.3); idempotency retention and the execution lease (§3.3); the store committing before the KeyStore policy-version mark (§3.4). G-24 adds: the relay columns of `identity` and `contacts` (§3) and `owner_agents` (§3.6), with the values of §4.3.

---

## 4. Transport

### 4.1 Interface (transport-agnostic)

```ts
interface Transport {
  wrap(envelope: Envelope, recipients: NostrRecipient[], keys: EnvelopeKeys): Promise<WrappedEnvelope>; // one gift wrap per distinct recipient key; publishes nothing
  publish(storedWrap: SignedWrap, relays: RelayUrl[]): Promise<PublishResult>; // exactly the row's relays (§3.2, §4.3), never any other
  subscribe(options: {                           // live form of sync (M1-9s): backlog from the cursor, then live
    relays: RelayUrl[];                          // the own list only (§4.3)
    identities: { pubkey: string; epoch?: number }[];
    persistence: { getCursor; setCursor; isSeen }; // the same object as for sync
    onEnvelope(item: { envelope; giftWrapId; relay; recipient }): 'processed' | 'verified' | 'retry';
  }): () => Promise<void>;                       // unsubscribe: CLOSE, no reconnect; resolves when in-flight handlers settle
  sync(options: {
    relays: RelayUrl[];                          // the own list only (§4.3); AUTH only there
    identities: { pubkey: string; epoch?: number }[]; // own Nostr keys at every epoch: the REQ's #p
    persistence: { getCursor; setCursor; isSeen }; // the core's sync_cursors and seen (§3.2)
    onEnvelope(item: { envelope; giftWrapId; relay; recipient }): 'processed' | 'verified' | 'retry';
    budgetMs?: number;                           // 3 000 by default (06 §6)
  }): Promise<{ partial: boolean }>;
}

// EnvelopeKeys (03 §3, 04 §3.1.1) exposes the secret-key operations the transport needs:
//   signNostr(event), nip44Encrypt(peerPubkey, plaintext), nip44Decrypt(peerPubkey, ciphertext, {epoch})
// It is the agent's KeyStore, or an OwnerSession on owner surfaces (owner-authored envelopes, owner copies).
// Seal signing uses the sender's key (seal key = envelope `from`); gift-wrap encryption uses a fresh
// ephemeral key created inside @4thtech-io/crypto. Size checks before JSON.parse: 04 §3.1.1.
```

**Two steps, store first (proposed, owner confirms at merge; IR-M1-7k-1 Q1).** Wrapping and publishing are separate calls so that the core can meet §3.2: it calls `wrap`, stores the outbound envelope with one outbox row per returned wrap in one store transaction, and only then calls `publish` for each stored wrap, with that row's relay list. A retry republishes the same stored wrap; nothing is wrapped or signed again. `wrap` publishes nothing; `publish` sends to exactly the relays it is given.

**Sync owned by the core (proposed, owner confirms at merge; M1-7h, IR-M1-7h-1 F05).** `sync` reads the relays it is given with the 48 h look-back of §4.2 and hands each newly opened wrap's strictly parsed, not yet verified envelope to `onEnvelope`. The core owns the cursors and the seen-set: the transport deduplicates by gift-wrap ID only (never by the sender-chosen envelope ID), and the handler's answer decides whether the wrap counts as handled and whether the relay's cursor may move (`retry` keeps both). The core skips a copy whose `envelopeHash` is already in `seen` before its signature check, by design: that row is written only after a signature over the same hash passed, so the envelope is verified once. `subscribe` follows the same handler shape.

An XMTP adapter (P2) implements the same interface, in the same two steps; envelopes are unchanged.

### 4.2 Nostr implementation

- **Wrapping:** NIP-59 gift wrap (kind 1059) of a NIP-59 seal (kind 13) containing an unsigned rumor (kind 14, tag `["agentlink","1"]`, `content` = envelope JSON). NIP-44 v2 encryption. Randomized `created_at` per NIP-59.
- **Relays:** each agent card lists 3–5 relays by default (a curated set of reliable public relays + the optional 4thTech relay); the bounds are in §4.3. Each gift wrap goes to the relays of the agent it concerns: the recipient's relays for the recipient's agent and owner, the sender's own relays for the sender's agent and owner (§4.3, G-24). Relay URLs from cards, invites and bodies are inbound content. They pass the raw-string relay URL schema at parse (04 §4, relay URLs). A relay host name with an all-numeric or `0x`-hex label anywhere (for example `1.relay.example`) is rejected, so relay operators, the 4thTech relay included, avoid such names.
- **Relay connections (M1-5; proposed, owner confirms at merge).** These rules close DNS rebinding and SSRF at connect time, on runtimes that control their own sockets (Node; the desktop app):
  1. Resolve the validated host string (A and AAAA).
  2. Accept the relay only if **every** resolved address is globally routable. Any other address skips the relay, and the activity log names it without the address.
     - **IPv4:** not in any block that the IANA IPv4 Special-Purpose Address Registry marks as not globally reachable. This includes `0.0.0.0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16`, `172.16/12`, `192.0.0/24`, `192.168/16`, `198.18/15`, `224/4` and `240/4`, plus `255.255.255.255`.
     - **IPv6:** inside `2000::/3`, outside every block that the IANA IPv6 Special-Purpose Address Registry marks as not globally reachable, and outside the blocks that embed IPv4 addresses: `2002::/16` (6to4), `2001::/32` (Teredo), `64:ff9b::/96` and `64:ff9b:1::/48` (NAT64). IPv4-mapped (`::ffff:0:0/96`), `::/128` and `::1` fall outside `2000::/3`.
  3. Open the TCP connection to the **checked address itself**, never to the host name again. TLS SNI, certificate verification and the HTTP `Host` header use the host name.
  4. Never follow a redirect on the upgrade, and repeat steps 1–3 on every reconnect.
  5. Ignore `HTTPS_PROXY`, `ALL_PROXY` and similar settings for relay connections: a proxy would resolve the name itself and bypass the check. A proxy option is a later owner decision.

  **Residual risk.** A browser `WebSocket` (the console) cannot resolve or pin an address. There, the schema rule and the platform apply: browsers enforce Private Network Access where it has shipped, and Workers cannot open connections to private addresses. M1-5 tests the steps above with a stub resolver: a rebinding answer, a mixed public and private answer, a 6to4 answer and a NAT64 answer are all skipped.
- **NIP-11 wait bound (M1-5b-c; proposed, owner confirms at merge).** The NIP-11 fetch uses the same checked address as the connection and has its own bounds: 3 s of waiting and 65 536 bytes. After the time bound the relay is used with the default limits for that attempt, and a failed or timed-out fetch is not asked again for 5 minutes. The document is untrusted: only `limitation.max_message_length` is read, and no part of it, nor the relay's path or query, is logged. Relay health and the activity feed name a relay by origin only. A row with fewer than 2 usable relays (message limit too small, blocked address) stays pending, and the activity feed says why with a fixed reason. The outbox adds up to 25 % of random jitter to each backoff step, never past give_up_at.
- **Delivery reliability:** publish to all listed relays, consider sent when ≥ 2 acknowledge (`OK`). Retry with backoff from the local outbox for up to 24 h, and **never republish a wrap that a receiver's sync could no longer find** (G-49; decided by the owner in D-71 (5), 15 Oct 2026, on the orchestrator's recommendation; revisit in M2). A relay that first stores a wrap at time `T` holds it under its randomised `created_at`, and a receiver that synced shortly before `T` next asks from `lastSync − 48 h − S`. So the outbox publishes a stored wrap only while `now ≤ created_at(wrap) + 48 h + S` (`S` = 300 s, the skew the sync uses), and the row's give_up_at is the earlier of that bound and its 24 h (§3.2). A row that reaches give_up_at without 2 `OK`s is `not_delivered` (reason `timeout`), as today; sending again makes a new wrap with a new timestamp (§3.2, "States"). The first publish is always inside the bound, because a wrap is never dated more than 48 h back. **Residual:** a wrap dated close to 48 h back gets a short retry window, so a relay outage at send time ends in `not_delivered` sooner; it costs delivery, never authenticity. The options left out (a wider look-back; a fresh wrap per republish; narrower timestamp randomisation) are recorded in G-49 for the M2 revisit.
- **Sync:** `REQ` with `#p` = own Nostr pubkeys, `kinds: [1059]`, `since = lastSync − 48 h` (NIP-59 randomizes gift-wrap timestamps up to 2 days back, so `created_at` cursors alone miss messages). The first sync on a relay with no cursor looks back 9 days (§4.3; G-24, accepted with D-65). Deduplicate by gift-wrap event ID before verification, and by `envelopeHash` once the signature has passed (04 §3.1.1 step 9), never by the sender-chosen envelope ID alone (keep a seen-set for ≥ 7 days, §3.2; confirmed by the owner, D-71 (3)). Support **NIP-42 AUTH**, since many DM relays serve kind 1059 only to the authenticated recipient. **Several identities (M1-5e; proposed, owner confirms at merge).** One REQ names all own keys. When a relay asks for AUTH, the transport logs in once per identity on the same connection: one kind 22242 event per identity, each signed through that identity's `EnvelopeKeys` and bound to the relay URL and the connection's challenge, so none can be replayed on another relay or connection. An identity that cannot sign (a locked `OwnerSession`) is skipped and the others still log in. A KeyStore signs only with its current key epoch, so an older epoch's key cannot log in: a relay that serves kind 1059 only to the authenticated recipient serves only the logged-in keys, and the older epochs are read only where the relay serves them without AUTH. The saved page position follows only gift wraps addressed to an own key, so a relay's stray events cannot move it.

  **Paging and the one-second residual (M1-5c, M1-5d; proposed, owner confirms at merge).** A relay may cap the events it returns per filter (newest first, then EOSE). So sync reads each relay in pages (`limit`, `until`) walking back to `since`, and moves the cursor only after the last page. Nostr pages only by whole seconds, so a relay that holds more than its cap of events at one `created_at` second cannot return the rest of that second, and the walk steps below it. No filter narrows that second on the same relay: a gift wrap carries only `#p`, and its author key is random.
  - **What the client does.** A page at `until = T` that holds only events at `T`, at least 2 of them and at least as many as any page of that walk so far (a relay's cap is at least that), reports `T` as a **gap** of that relay, with the fixed reason `relay_cap` and no relay text. `sync` returns the gaps that the re-query below did not close. A live subscription logs each one by relay host only, never the second, and sends no re-query.
  - **Closing a gap by `ids` (M2-19; proposed, owner confirms at merge).** After the pages of a `sync` pass, a gap of relay R at second `T` is closed when another relay S of the same pass meets every condition below:
    - S completed its pass, has no gap at `T`, and its walk shows positive evidence that it read `T` in full (IR-M2-19-1 H-1). "No gap" alone is no proof, because the M1-5d detector needs at least 2 events per page and misses a cap that changes. The only evidence is a page whose range holds `T` that also held an older wrap for us that opened or was seen before (stray, foreign or junk frames never count); when `T` equals that page's `until`, an event must also have sat at `until` on that page, because a relay that applies `until` exclusively never served `T` there (AUDIT-FABLE-M2-19-1). A page smaller than the largest page proves nothing, because a lower cap can cut it (IR-M2-19-2 H-2). `T` must lie above S's `since`, since a walk may stop inside its oldest second. A walk that ended because S ignores `until` proves nothing;
    - S served every wrap R showed at `T`, plus wraps at `T` (each opened, or seen before) that R did not show;
    - one query on R, `{ids, kinds: [1059], #p, since: T, until: T}`, asks for those wraps and gets back every one, at `T`, opening or seen before.

    Then S read that second in full and R holds what S holds there. The bounds are fixed: one query per gap, at most 64 ids per query (a gap with more missing ids is not queried), at most 16 queries per pass, 1 s per query, all inside the pass budget. A pass remembers at most 2 048 wrap ids per relay, and a relay past that bound closes no gap in that pass. The answer is untrusted (I-5): events not asked for are dropped, more frames than ids ends the query, and nothing of it is logged; the log carries only the count of closed gaps. Every gap that is not closed stays in the result, and core reports it as incomplete (M1-5g). **Residual:** a wrap that only R holds at `T` stays unread even when the gap is closed, because no relay can name an id it never served. Every id asked for was already delivered from S, so R's copy comes back as `duplicate` before any verification, and R can "confirm" by echoing an id. That gives R no new power, because R controls its own gap anyway. The proof assumes S returns stored events newest first and applies `until` inclusively (NIP-01). A relay that caps oldest first, or serves events outside the filter, can make a second look fully read; such a relay already loses events in the page walk itself. NIP-77 negentropy remains the complete fix.
  - **Why the pass goes on.** A gap neither holds the cursor nor makes the pass partial. Reading the same relay again cannot fetch that second, and holding the cursor would let a junk flood at one second stall sync. Coverage comes from the relay list: each wrap goes to every relay of the agent's list (3–5), so a flood that hides a wrap must saturate that second on every relay that holds it.
  - **Residual.** A relay whose cap changes between pages (a byte or time limit instead of a count) can cut a second without it being reported. A relay that returns its whole window in one page, all at one second, is reported though it held nothing more: a false alarm that costs nothing.
  - **Later options (not built).** One query per `#p` key for a saturated second when the agent has several keys; NIP-11 `limitation.max_limit` as a hint for the cap; NIP-77 negentropy where a relay supports it, the only complete fix.
- **Size:** envelope ≤ 24 KB serialized (24 576 bytes; the relay-frame, envelope, recipient and `ct` limits and where each is enforced are in 04 §3.1.1); inline files ≤ 12 255 bytes of content (12 288 bytes of `ALF1` ciphertext, 04 §3.4); check the final gift-wrap size against each relay's NIP-11 `max_message_length` and skip relays that cannot carry it.
- **Relay retention:** public relays may drop events; agents should sync at least daily. The optional 4thTech relay keeps gift wraps for 30 days (it only ever sees ciphertext).
- **Owner copies:** the owner console subscribes with the owner Nostr key on the relays of all its agents and receives copies of all envelopes for its agents (§4.3). Reading them, including NIP-42 AUTH, runs in an `OwnerSession` with presence (04 §3.1.1).

### 4.3 Relay lists and owner copies (G-24; D-65, accepted by Tali, 2026-10-14, at merge of 4thtech/agentlink#51)

An owner has no relay list of its own: a card carries only the agent's `relaysHash` (04 §2.4), and no sender knows where an owner reads. So every wrap goes to the relays of the agent it concerns, and an owner surface reads on the relays of all its agents. Every value in this section was accepted by the owner at the merge of 4thtech/agentlink#51 (D-65).

**The rule.**
- **Publishing.** Each gift wrap is published to the relay list of the agent its recipient key belongs to, or, for an owner key, of the agent whose owner it is in this envelope. When one owner key is the owner of both the sending and the receiving agent (one entry, 04 §3.1.1), its wrap goes to the union of both lists.
- **Reading.** An owner surface (the console, the desktop app) subscribes with `#p` = its own `ownerNostr` on the union of the bootstrap set and the authenticated lists of all its agents, below.

| Wrap for (04 §3.2, §3.4.1) | Published to |
|---|---|
| The contact's agent, and the contact's owner (§3.2 entries 1 and 2) | The contact's list (the `relays` of its current card) |
| The sender's owner and the sender agent (entries 3 and 4) | The sending agent's own list |
| Owner channel, agent → own owner (`approval-request`, the `policy` echo) | The agent's own list |
| The owner `card-update` (below) | The agent's old list, its new list and the release's default relay set |
| Owner channel, owner → agent (`approval`, `policy`) | That agent's list, as the surface holds it |
| `revoke` | The revoked agent and its owner: the revoked agent's list. Each contact's agent and owner: that contact's list, from the owner's copies (04 §3.4.1, "Revoke delivery"). A contact whose list the owner does not hold at all (a pairing from before `handshake-ack` carried `relays`) gets its wraps on the bootstrap set, and the console marks it as possibly not told |
| Pairing (`handshake`, `handshake-ack`) | As the first two rows; the invitee takes the inviter's list from the invite, the inviter the invitee's from the `handshake`. The `handshake-ack` repeats the inviter's list (04 §3.4.1), so the invitee's owner holds it too |

- **Sent.** A row of `outbox` (§3.2) is `sent` once 2 relays of the list it was published to returned `OK`, for `owner` rows as for `contact` rows. Republishing to any of these relays stops at the row's give_up_at, which the sync look-back bounds (§4.2 "Delivery reliability", §3.2; G-49, D-71 (5)). Per-key routing means each relay sees only the wraps of the agents that use it.
- **Placement is unaffected.** The relay a copy arrived on confers nothing. An owner surface places every copy only by the attribution rules of 04 §3.1.1 ("Where the owner shows a copy") and stores it in `owner_copies` (§3.6), deduplicated across relays by its key.

**Where a list comes from, and how it is authenticated.** A relay list is the verbatim `relays` array whose `keccak256(JCS(relays))` equals the `relaysHash` of a card. The card's `cardSig` binds it to the owner (04 §2.4), so the list is as authentic as the card. No other source is used.
- **The agent's own list.** The list in the agent's current card, kept in `identity` (§3) when the card is built.
- **A contact's list.** From the invite, `handshake` or `card-update` that carried the contact's current card. The list passes the relay URL rule at parse (04 §4; the whole body is rejected on one bad URL) and must match `relaysHash`, with `name` matching `nameHash`, as 04 §3.4.1 (`card-update`, `handshake-ack`) and §3.6 (Accept step 1, Complete) now require (G-24). PR #48's `checkCard` (M1-7a) already makes both checks for contacts. Lists carried with a card hold 2 to 16 relays (04 §3.4).
- **An owner surface's list for one of its agents.** A card that passes the card checks (04 §2.4), whose `cardSig` recovers to the surface's own `ownerEvm`, and whose `ownerNostr` and `ownerEnc` equal its own keys. The list comes from one of:
  - the surface's own signing of that card (add agent, key rotation; M2-2e);
  - the owner's copy of that agent's own `handshake`, `handshake-ack` or `card-update` (agent → contact), or of the owner `card-update` (below), once the copy is placed as sent by that agent (04 §3.1.1);
  - the owner link from the CLI (M2-2c), which carries `{card, cardSig, name, relays}` for each agent the CLI holds, inside the same encrypted, code-checked transfer.

  A list replaces the stored one only with a card of strictly greater `keyEpoch` for the same `agentEvm` (compare-and-set). A revoked agent stays revoked. If a second relay change arrives while the surface's overlap for that agent still runs (a conforming agent refuses this, below), `prev_relays` becomes the union of both previous lists, at most 16 relays, until the later end time, so no list that contacts may still use is dropped.
- **Contacts of an invitee.** When the owner's agent was the invitee, the invite is not an envelope, so the owner learns the inviter's list from its copy of the `handshake-ack`, which now carries `relays` (04 §3.4.1; D-65, amends D-58). This changes `handshakeAckBodySchema` in `@4thtech-io/types` and the pairing vectors (`safety-code-recompute`), so it lands before M1-7c (card M1-2d).
- **The bootstrap set.** The release's default relay set (the list that `init` picks from, §4.2), plus relays the owner enters under Settings. The owner's entries are local settings, pass the relay URL rule and are never published.
- **Never a source:** NIP-65 or NIP-17 relay-list events (kinds 10002 and 10050), relay hints in event tags, NIP-11 documents, redirects, or any list from a contact about another party. No public relay-list event is published for an agent or an owner. An `OwnerSession` cannot sign one anyway (04 §3.1.1).
- **SSRF.** Every list from any source is checked by the raw-string schema at parse (04 §4), and every connection by the connect-time rules of §4.2 on runtimes that own their sockets (Node, the desktop app). The console keeps the browser residual risk stated in §4.2.

**Owner `card-update` (owner channel; D-65, amends D-58, 04 §3.4.1).** The core sends one `card-update` (body unchanged) on the owner channel for its first card at `init` and each time it applies a new card, even when it has no contacts. Recipients are exactly the agent and its own owner. It is published to the agent's old list, its new list and the release's default relay set, which every owner surface reads, so a surface that did not sign the card, was offline, or is on a new device finds the agent. The core re-publishes it every 24 h during an overlap and every 7 days otherwise, each time as a new gift wrap of the same stored envelope (the next outbox attempt, §3.2). A surface that has a cursor for a relay finds it within its 48 h look-back. A surface's first sync on a relay with no cursor (a new device, a relay newly added to the union) uses `since = now − 777 600` (9 days: the 7-day re-publish plus the 48 h NIP-59 back-dating), so it finds the latest re-publish as long as the relay keeps events for at least 7 days. Under Advanced, the owner can turn off announcing one agent on the default set (Privacy, below); that agent's owner `card-update` then goes only to its own lists. The card inside is owner-signed with presence; the envelope confers nothing; only core flows create it, and no MCP tool can create or pass it through (I-4). Surface checks, the two recipient sets of `card-update` and the agent's own copy: 04 §3.4.1.

**Counts.**

| What | Value |
|---|---|
| The agent's own list, as signed into its card | 3 to 5 relays by default; 2 to 8 under Advanced. The core refuses to build a card outside 2 to 8 (M1-7j). Below 2, no wrap could reach `sent` |
| A list received with a card (invite, `handshake`, `handshake-ack`, `card-update`) | 2 to 16 entries, unique (04 §3.4; the minimum was 1). A contact can still have fewer than 2 *usable* relays (connect-time skips, NIP-11): its rows end `not_delivered` (§3.2), and the activity feed says why |
| The owner's own Settings entries | 1 or more; local only |
| Relays per wrap | At most 32: a received list has at most 16 entries, an own list at most 8 (16 during its overlap), and the union for one owner of both agents at most 32. The owner `card-update` also goes to the release's default set |
| Agent relay pool (M1-5b) | At most 64 open connections; a connection idle for 5 minutes is closed; a relay that has not connected within 10 s is skipped for that attempt |
| Owner surface, connections | At most 32 at once, subscribing and publishing together. The remaining relays of the union are synced in turns with the 48 h look-back (§4.2). Target: each relay at least every 15 minutes while the surface is open; the surface shows, per agent, when its relays were last synced, and that updates may be late. Revoke publishing to many contacts runs in turns under the same cap. The surface never logs in (NIP-42) with the owner key on a relay that is only in a contact's list: it publishes there without AUTH and skips a relay that demands it |

**Relay changes and key rotation.**
- **A relay change is a key rotation.** `relaysHash` is in the card, and a contact applies a new card only with a strictly greater `keyEpoch` (04 §3.4.1). An agent therefore changes relays only by rotating (04 §2.6): new card, `card-update` to each contact, owner `card-update` to its owner. It is an owner operation with presence, offered only under Advanced (D-39, D-40), from the CLI or the console (M1-7j).
- **One change at a time.** The core refuses a relay change while an overlap is still running (`identity.prev_relays_until` > `now`). A rotation that keeps the same list, such as one after a key compromise, is always allowed, and leaves `prev_relays` and `prev_relays_until` unchanged. So there is never more than one previous list, and no list that contacts still publish to is dropped.
- **The agent's overlap.** For 30 days (2 592 000 s, the 4thTech relay's retention, §4.2) after it applies the new card, the agent keeps syncing and subscribing on the old list as well, because contacts that have not yet applied the `card-update` still publish there, and publishes the wraps routed to its own list to the old and the new list. The old list is kept in `identity` with its end time (§3). Time is the store's `now` (§3.1).
- **Contacts.** A contact switches to the new list when it applies the `card-update` (in each sync pass `card-update` first, 04 §3.1.1 step 7). It publishes to the new list only. Envelopes it sent before then are on the old list, which the agent still reads.
- **Owner surfaces.** When a surface accepts a new card for one of its agents, it keeps the old list in the union for the same 30 days. The owner `card-update` reaches the old list and the default set, both of which the surface reads, and is re-published (above), so a surface that was closed for longer than the relays keep one copy still finds a later one. Arrival order does not matter: the new card is applied whatever relay delivered it, and copies from the new key are placed by 04 §3.1.1 once it is.
- **Revoked agents.** An owner surface keeps a revoked agent's list in the union for 30 days after the revoke, then uses it only to re-publish the revoke (04 §3.4.1).
- **Residual.** A contact that stays offline longer than its own relays keep the `card-update`, and longer than the 30-day overlap, never sees the new list. What it later publishes goes to the old list, which the agent no longer reads. This is the existing rotation limit (04 §2.6, 24 h outbox retry), made visible by the relay change; it is not closed here. Likewise, a new device finds an agent through the default set only if those relays keep events for at least 7 days (the re-publish interval).
- **Owner-key rotation** is P2 (04 §2.6) and outside this section.

**Fail closed.**
- A list that fails the schema, does not match `relaysHash` or comes with a card that fails its checks is refused as a whole, with the card or body that carried it. The previous list stays in use.
- If the list for any recipient key of an envelope cannot be read, nothing is published and the send returns `error` before the outbox write (§3.2, "On failure"). A wrap is never published to relays other than those its row lists.
- An owner surface shows an agent's activity as possibly incomplete when it cannot read or authenticate the agent's list, has fewer than 2 usable relays for it, or has synced none of its relays successfully in the last 7 days. It never shows such an agent as up to date, and it never falls back to an unauthenticated source. The copy (11 §5) says that activity from this agent may be missing on this device.
- An owner surface that holds no list for an agent (a new device that has not yet seen its owner `card-update`) cannot send it an `approval` or `policy`: the send fails closed, and the console says it cannot reach that agent from this device yet, pointing to the owner link (M2-2c) or to waiting for the agent's next owner `card-update`. The approval stays pending until its own expiry (04 §3.4.1).
- An own `identity.relays` that cannot be read stops all sending. The activity feed and `doctor` name it as the cause, so it does not show only as `error` on every send.
- All owner-surface subscriptions, including NIP-42 AUTH with the owner key, run inside the `OwnerSession` (04 §3.1.1, "Reading needs presence"). When the session ends, the surface closes them.

**Privacy.**
- **What relays learn.** As 03 §5 states: ciphertext, the recipient key in the `p` tag, randomised timestamps and the connecting IP. A relay that serves kind 1059 only after NIP-42 AUTH also learns the key that logs in.
- **Linkability between an owner's agents.** Every card names its `ownerNostr`, so anyone holding two cards (a contact of both agents, or the public Registry for registered agents) links them anyway. Relays add one path: the owner's subscription, its AUTH and the `p` tag of its wraps carry the same `ownerNostr` on the relays of every agent. A relay used by two agents of the owner, operators that collude, or one that sees the console's IP link those agents to one owner. Per-key routing limits what a relay sees of the owner's other agents' traffic, but not the subscription. Unlinking them needs one owner key per agent, a new card field, which is not proposed (04 §3.1.1).
- **Mitigations.** An owner surface's filter holds only `ownerNostr`, never agent keys. No relay-list event is published for owners or agents, and the owner's own relay settings never leave the device. Agents share the default set unless the owner chooses otherwise, so a relay set is rarely a fingerprint. The IP is not hidden: a proxy or Tor option is a later owner decision (§4.2).
- **Announcing on the default set.** An agent that uses only custom relays still publishes its owner `card-update` to the release's default set every 7 days, from its own host. Default-set operators, the 4thTech relay among them if it is in the set, then learn the agent host's IP linked to `ownerNostr` (the wrap's `p` tag), roughly how many agents the owner has (wraps from different IPs), and that the owner has agents they would otherwise not see. For agents already on the default set, nothing changes. **Opt-out (Advanced, per agent; proposed, owner confirms at merge):** "don't announce this agent on the default relays". The cost: a surface that has not signed the card or received the owner link learns the agent only from its own lists, so a new device finds it only through the owner link (M2-2c).
- **The 4thTech relay.** If the release's default set includes the optional 4thTech relay, the surface subscribes and logs in there too, so 4thTech learns the owner key, the IP and when the owner is online, though never content. Under Advanced, once the surface holds a list for every agent, the owner may leave the default set out of the subscription; the cost is that a new agent, or a relay change the surface missed, is then found only through the agent's own lists.

---

## 5. Storage adapter

### 5.1 Interface

```ts
interface StorageAdapter {
  kind: "inline" | "drop" | "s3" | "gdrive" | "dropbox" | "onedrive" | "ipfs";
  put(ciphertext: ReadableStream | Uint8Array, opts: { size: number; expiresAt: Date }): Promise<StoredObject>; // hashes the ciphertext while streaming (one encryption pass, §5.4); StoredObject.sha256 is that hash
  presignGet(obj: StoredObject, expiresAt: Date): Promise<string>;   // URL the recipient can use without credentials
  delete(obj: StoredObject): Promise<void>;
}
type StoredObject = { kind: string; locator: string; size: number; sha256: string; keyEpoch?: number }; // keyEpoch: drop upload epoch (§5.4, D-108)
```

### 5.2 S3-compatible adapter (P0)

- Works with Cloudflare R2, AWS S3, Backblaze B2, Hetzner Object Storage, Scaleway, Wasabi, MinIO.
- Uses `aws4fetch` (SigV4 over `fetch`) so it runs in Node, browser and Workers.
- Object key: `agentlink/<storagePrefix>/<random 128-bit>`: a random per-agent prefix, never the agent ID (04 §2.9), and no file names or contact info.
- Multipart upload for files > 64 MB; streaming encryption so large files never fully load into memory.
- Presigned GET valid until `expiresAt` (max 7 days per SigV4; shorter with temporary credentials). The recipient can ask for a fresh link (`request` envelope, `kind: refresh-link`); the sender's core answers when online, with a new presigned GET that never outlives the file's `expiresAt` (04 §4, M1-7f-3; proposed, owner confirms at merge).
- Lifecycle: the CLI's `storage connect` offers to set a bucket lifecycle rule deleting `agentlink/` objects after 30 days, and aborting incomplete multipart uploads under `agentlink/` after 1 day, as a safety net; the bucket's other rules are kept (M1-6b).
- Credentials (access key ID + secret) stored in the KeyStore item `s3:<id>` (04 §2.2; the OS keychain or the file KeyStore), bound to the owner-signed `storage.set` by `credentialDigest` (04 §2.5.1), or in Worker secrets (cloud). Temporary credentials are refused in M1. Not part of the recovery kit (04 §2.3.3, D-115 D). The non-secret config (provider, endpoint, bucket, region) lives only in the signed `storage.set`, kept in `own_storage` (§3.4), never in `config.json` (§9.1: unsigned, it may only make the agent fail to open). Recommended: a bucket-scoped key with only `PutObject`, `GetObject`, `DeleteObject`, `AbortMultipartUpload` and `ListBucketMultipartUploads` (the last two let a failed or interrupted multipart upload be cancelled and cleaned up, M1-6b; on AWS IAM they are separate actions, so without them an abort is refused). Setting the lifecycle rule needs the bucket-level `PutLifecycleConfiguration` (and `GetLifecycleConfiguration` to read it back), which this key does not include; when the key lacks it, `storage connect` explains how to add the rule in the provider console instead.
- **Guided setup** (`agentlink storage connect` and local UI): provider picker → step-by-step instructions with links → test upload/download/delete → save.

### 5.3 Inline adapter (P0)

Files of at most 12 255 bytes (12 288 bytes of `ALF1` ciphertext, 04 §3.4) are base64url inside the payload; no storage needed.

### 5.4 Encrypted drop adapter and service (P0, D-48)

The default store for files over 12 255 bytes, so file exchange needs no setup. The `drop` adapter implements the same `StorageAdapter` interface; the service is a 4thTech Cloudflare Worker (`apps/drop`) in front of an R2 bucket, served from its own host (beta: `drop.agentlink.4thtech.io`, D-28). Security rules are in 04 §4.

| Endpoint | Request | Behaviour |
|---|---|---|
| `POST /v1/upload` | Signed by the agent's drop key (04 §2.1): `{v: 1, size, expiresAt (≤ 7 days), nonce, ts}` plus the signature and the drop key's public key | Verifies the signature, the nonce and timestamp window, the size cap, the weekly quota per drop key and the rate limits per drop key and per IP. Returns `{objectId (random 128-bit, base64url), uploadUrl, expiresAt, uploadExpiresAt}`: `uploadUrl` is a short-lived (15 minutes), single-use signed PUT target that accepts exactly `size` bytes. Above the part size (64 MiB) it returns `parts: [{part, size, uploadUrl}]` instead of `uploadUrl`, one target per part (M1-27a) |
| `PUT <uploadUrl>` | Ciphertext bytes (ALF1) | Stores the object; rejects a `Content-Length` other than the declared (part) size, an expired or tampered target, or a second PUT to the same target, and never overwrites a stored object. Files above 64 MiB get one signed target per part (multipart, any order), under the same limits. A failed PUT leaves the upload uncommittable; the client starts a new upload (M1-27a) |
| `POST /v1/o/{objectId}/commit` | Signed by the same drop key: `{v: 1, objectId, ciphertextSha256, nonce, ts}` | Completes the upload: compares `ciphertextSha256` with the SHA-256 of the stored bytes, which the Worker computes as it streams them back once (multipart parts are joined first, so the hash covers exactly what will be served; M1-27a, proposed, owner confirms at merge). On a match the object becomes readable and the Worker returns `{getUrl, expiresAt}`, a signed GET valid until `expiresAt`; on a mismatch it deletes the object |
| `GET <getUrl>` | — | Serves the ciphertext as `application/octet-stream`, `Content-Disposition: attachment`, `nosniff`, a sandboxing CSP and CORS for browser recipients (08 §7); refuses after `expiresAt` or above the per-object download limit |
| `DELETE /v1/o/{objectId}` | Signed by the uploading drop key (same format, method `DELETE`): the drop key of the epoch the object was uploaded under, which the client records with the object (04 §2.1), so a DELETE after a key rotation still verifies | Deletes the object when retention triggers (`files.deleteAfter`, 04 §4). Only the uploading drop key can delete |
| `POST /v1/report` | `{v: 1, url, reason}`: a `getUrl` of this drop whose MAC verifies (expired or not), and `reason` one of `malware`, `illegal`, `spam`, `other` | Abuse report path: deletes only that object; blocking a drop key needs human review (04 §4). Never accepts file keys, envelopes or plaintext |
| `GET /v1/health` | — | Liveness only; aggregate counters stay internal |

- **Signature format (M1-27a; proposed, owner confirms at merge).** A NIP-98-style HTTP-auth event, kind 27235, signed with the drop key (BIP-340 over the NIP-01 event id) through the `KeyStore` (`signDropRequest`, M1-1g-e: the KeyStore fixes the kind and `domain` tag, signs only POST and DELETE over the drop's signed JSON body with `created_at` equal to its `ts`, and refuses anything else with one fixed error), sent as `Authorization: Nostr <base64url(JSON event)>`. Its `content` is empty and its tags are exactly, in order, `["u", <the exact request URL>]`, `["method", "POST" | "DELETE"]`, `["payload", <lowercase hex SHA-256 of the exact body bytes>]` and `["domain", "agentlink/v1/drop"]`; `created_at` equals the body's `ts`. The Worker compares `u` with the request URL as its runtime serialises it (WHATWG URL: lowercase scheme and host, no default port, normalised percent-encoding), so a client signs `new URL(url).href` and sends exactly that URL. Every signed request (upload, commit, DELETE) has a JSON body with `v`, `nonce` (16 random bytes, base64url) and `ts`, so the `payload` tag covers the nonce. The Worker checks, in order: the header form, the binding to method, URL and body, `|now − created_at| ≤ 60 s`, then the id and signature; then it refuses a nonce the same drop key used in the last 10 minutes. The kind and the `domain` tag separate it from envelopes, records, receipts and relay AUTH (kind 22242), and the drop key is never the agent's Nostr or EVM identity key. Signatures travel in a header, not in the URL path or query. Vectors: `test-vectors/drop-auth`, in Node, the browsers and workerd.
- **Signed URLs (M1-27a).** `PUT https://<drop>/v1/put/{objectId}/{part}?e=<expiry>&m=<mac>` (part 0 for a single PUT, 1 and up for multipart) and `GET https://<drop>/v1/get/{objectId}?e=<expiresAt>&m=<mac>`, with `m` = base64url HMAC-SHA256(urlKey, utf8("agentlink/v1/drop-url") ‖ 0x00 ‖ purpose (0x01 put, 0x02 get) ‖ objectId (16 bytes) ‖ u16be(part) ‖ u64be(expiry)). `urlKey` is derived from a Worker secret and never leaves the Worker. Clients treat both URLs as secrets (I-7).
- **Mapping to the interface.** `put` = `POST /v1/upload`, `PUT` of the ciphertext, then the signed commit. The file is encrypted exactly once, with one file key and one nonce prefix; the core hashes the ciphertext as it streams it (hash as you go) and sends `ciphertextSha256` in the commit. If a hash is ever needed before the upload, the core encrypts once to a private temporary file and uploads exactly those bytes. It never re-encrypts with the same file key and nonce prefix; a retry re-sends the same bytes or encrypts afresh with a new file key and nonce prefix. Threat note: if the file changed between two encryption passes, the same key and nonces would encrypt different plaintext (AES-GCM nonce reuse). `presignGet` returns the `getUrl` from the commit; the object expires at the requested `expiresAt` (at most 7 days after upload), and a `refresh-link` answer cannot extend it. `delete` = signed `DELETE`.
- **Upload epoch (M1-1g-g, D-108).** `put` reads the KeyStore's current epoch before the upload and records it with the object (`keyEpoch`; the core keeps it in the sealed `files.locator`, §3). The upload and the commit are signed at the current epoch, never with an `epoch` option; if the epoch has moved once either is signed, `put` sends nothing more, deletes what it started at the recorded epoch and fails `upload_failed`. `delete` passes the recorded epoch to `signDropRequest` (`{epoch}`, DELETE only, M1-1g-f); an epoch above the current one is refused before anything is sent (`credentials_unavailable`, one fixed message). An object recorded without an epoch is deleted at the current one.
- **Expiry.** Hard 7 days from upload, enforced by the Worker on every GET and by an R2 lifecycle rule as the backstop.
- **Limits (M1-27a; the size cap and weekly quota confirmed by the owner, D-129; the other limits proposed, owner confirms at merge).** 100 MiB of ciphertext per file and 1 GiB per drop key in any rolling 7 days, reserved when the upload is granted. Errors are typed JSON: `{error: "limit", limit: "size" | "quota" | "downloads"}`; the core maps `size` and `quota` to `needs_setup` (06 §2.3). Transient refusals are retryable and never mean `needs_setup`: `{error: "rate_limited", retryable: true}` (HTTP 429) and `{error: "unavailable", retryable: true}` (HTTP 503), both with `Retry-After`. Rate limits: per drop key, 60 upload grants and 240 signed requests per hour. Per IP (IPv6 per /64): 10 drop keys admitted for the first time in any rolling 24 hours, 20 reports per hour, and an absolute ceiling of 3 000 signed requests (upload, commit, DELETE) in any rolling hour for all keys together, checked before any drop key's state is touched.
  - **Shared egress.** The fresh-key limit applies only to a drop key's first upload. A key admitted before is never subject to it, so users behind an office or carrier NAT keep working with their own keys when new keys from that address are limited; only new keys wait. The only per-IP limit an admitted key meets is the absolute ceiling, which is sized as an abuse backstop well above a busy shared address. Many fresh keys from one source remain the residual sybil risk (04 §4), bounded by the fresh-key limit and the global cap.
  - **Global cap.** 500 GiB granted in any rolling 24 hours and 20 000 grants per hour. When it is reached the drop fails closed with `unavailable` and `Retry-After`: no object is created, and the refused request's key and IP counters are refunded. It never drops data silently.
  - **Download limit (owner-confirmed 23 Oct 2026).** 16 downloads per object, twice the 8-recipient envelope maximum (04 §3.1.1), so every recipient of the largest recipient set can fetch a file twice without the sender telling the drop how many recipients there are. A download counts only once the stored bytes have been read from R2, so a failed read uses none. Above the limit the drop answers `limit` `downloads`; the sender can upload again.
- **State.** Quota and nonce counters in Durable Objects; no accounts, no file names, no recipient data. Logging per 04 §4 (I-7): aggregate counters only; no request URLs, signed URLs, object IDs, drop keys or upload signatures in any log, metric label or analytics, with or without IPs. Workers observability and request logging and Logpush stay off for the drop Worker in production. Residual risk: Cloudflare, as the infrastructure operator, can see request metadata; contents stay ciphertext.

### 5.5 Consumer storage connectors (P1, M2, D-49)

`gdrive`, `dropbox` and `onedrive` adapters implement the same interface, in the desktop apps (08 §8): Settings → Storage → Connect. OAuth uses PKCE with a loopback redirect; tokens stay in the OS keychain (04 §4). Each adapter stores only ALF1 ciphertext with a random 128-bit name in a dedicated app folder; `presignGet` creates a share link for one file; `delete` removes the file (and its link). Registering the OAuth clients is an owner action.

| Provider | Scope (minimal) | Expiring public link | Status |
|---|---|---|---|
| Google Drive | `drive.file` (files the app created) in a dedicated folder | **No:** "anyone with the link" permissions cannot expire (only user and group permissions can) | `DECISION NEEDED (owner)`: accept sender-side revocation at expiry, or ship without Drive |
| Dropbox | App-folder access | **Paid plans only:** link expiry is not available on free (Basic) accounts; temporary download links last only hours | `DECISION NEEDED (owner)`: free accounts fall back to sender-side revocation, or are not offered |
| OneDrive | App folder (`Files.ReadWrite.AppFolder`) | `createLink` accepts `expirationDateTime`; support on personal accounts must be verified | `DECISION NEEDED (owner)`: Graph documents `Files.ReadWrite` as the least-privileged permission for `createLink` on personal accounts, broader than the app folder |

- **Sender-side revocation**, where a provider has no expiring link: the sender's agent deletes the file and revokes the link at expiry or on receipt, per `files.deleteAfter`. This is best effort: it runs only while the sender's device is online, so a link can outlive 7 days (D-18, amended in D-49) until the next start; the content stays encrypted.
- Each adapter card verifies the provider's current link semantics, direct-download URLs (within the SSRF redirect cap of 2) and CORS for browser recipients (08 §7) before it ships.
- **Not a transfer point:** the sender's local disk is never used to serve files, because the recipient may fetch while the sender is offline. Local copies of sent and received files stay on the device.
- **Cloud agents** keep the R2 bucket the template creates in the user's own Cloudflare account (08 §3.1).

### 5.6 Storage selection

Applied by the core for every file (06 §3 `files.storage`):

1. File of at most 12 255 bytes → `inline` (§5.3), unless the payload would then exceed 17 136 bytes: the largest inline files move to steps 2–5 until it fits, and a payload that still does not fit is `rejected` `PAYLOAD_TOO_LARGE` (04 §3.4 inline packing, G-27, D-85).
2. `files.storage: own` → own storage; if none is configured → `needs_setup`. Never the drop.
3. `files.storage: auto` (default) and own storage configured → own storage. No silent fallback to the drop if own storage fails.
4. `auto` or `drop`, within the drop limits (size cap, weekly quota) → `drop`.
5. Otherwise → `needs_setup`, naming the limit and the own-storage option.

Own storage means the S3-compatible adapter, or a consumer connector from M2. `agentlink_status` reports the result as `storage.mode` (06 §2.1).

Own storage counts as configured when a `storage.set` row exists, also when it is `broken` (signature, credentials missing or mismatched, or the row and `storage-mark` disagree; §3.4). A broken own storage makes the tool return `needs_setup` with reason `storage_broken` (core refusal `needs_storage`) naming `agentlink storage connect`, never the drop (M1-9i, D-115; IR-M1-9i-s-1). The runtime builds the S3 adapter only for `ready`; for `broken` it passes an adapter stub that refuses every call (`credentials_unavailable`), so `files.storage: auto` never falls back to the drop. `doctor` reports `broken` with the fix, naming no endpoint, bucket or key. The credentials are read from the KeyStore item at each use and never become log fields (I-7). In M1, `agentlink_status` keeps `storage.mode: "own"` for a broken own storage, so the frozen output schema (06 §2.1) does not change; the breakage shows through `needs_setup` on send and in `doctor`. A status field for it is a later, separate change (IR-M1-9i-s-1).

### 5.7 Later adapters

- `ipfs-pinning`: Pinata / Filebase / Storacha (P2).
- Filecoin Onchain Cloud or a future PollinationX v3 adapter (post-beta).

---

## 6. Chain package

### 6.1 Config

```ts
type ChainConfig = {
  key: "base" | "gnosis" | "arbitrum" | "optimism" | "polygon" | string;
  chainId: number;
  rpcUrls: string[];                // multiple public + optional user-provided; fallback transport
  contracts: { vault: Address; notary: Address; registry?: Address };
  feeTokens: { symbol: "NATIVE" | "USDC" | "USDT"; address: Address | null; decimals: number; eip3009?: boolean; source: Source }[];
  explorer: string;
  confirmations: number;            // display threshold; 04 §5 fallback depth only where finalizedTag is false
  finalizedTag: boolean;            // the chain answers eth_getBlockByNumber("finalized")
  testnet: boolean;
  source: Source;                   // official page for the chain ID, RPC and explorer entries
};
type Source = { url: string; verifiedOn: string };  // https URL; YYYY-MM-DD
```

**Sources, finality and composition (proposed; owner confirms at merge; M1-14, IR-M1-14-1 L-4, L-5).**

- Every chain entry and every `feeTokens[]` element carries a required `source`: the issuer's or chain's official page and the date it was last checked (12 §3.2). The private deploy configuration (occ-v2-contracts `script/config`) records the same values, and its verify-chain script checks them against chain state.
- `finalizedTag` is true where the chain answers the `finalized` block tag (proven by verify-chain), so the client never probes. There, 04 §5 reads chain state at `finalized`, and `confirmations` is only the threshold for showing a proof as included. On a chain without the tag, `confirmations` is also the 04 §5 fallback depth. It is never a reorg-safety bound.
- The client ships one network entry per chain without `contracts` (`@4thtech-io/chain`, M1-14). The registry (M1-4a) composes each `ChainConfig` from that entry plus `contracts` from the pinned in-repo `@4thtech-io/occ-v2-abi`, once M1-3g has deployed them.
- At most one fee token per symbol on a chain, so the user can tell tokens apart by symbol.

At launch `feeTokens` lists only USD stablecoins (D-46, 12 §3): USDC, USDT where available, and on Gnosis the native xDAI (`symbol: "NATIVE"`, `address: null`). A volatile native coin is never a fee token at launch (`NATIVE` on other chains is used only for gas in direct mode).

Users can override RPC URLs (privacy, reliability). No API keys baked into the client.

**Registry, RPC URLs and the read client (proposed; owner confirms at merge; M1-4a).**

- **Registry.** The supported chains are the shipped network entries that have a deployment in the pinned `@4thtech-io/occ-v2-abi` release, in deployment order: Base Sepolia (84532) today; Gnosis Chiado joins when M1-3j deploys there. Composition fails closed when the release and the entry disagree on the chain ID, the testnet flag or the fee tokens (address, native flag and decimals). Contract addresses are stored lowercase. A token is marked `eip3009` only where the token supports it **and** the deployed vault accepts `depositWithAuthorization`; that is false until M1-3c, so no client offers the flow before the contracts do.
- **RPC URL rule.** Shipped URLs and the user's overrides (at most 5 per chain) pass the 04 §4 raw-string rule before any client exists: `https://`, then a host that passes the relay host rule (lowercase DNS name, two or more labels, no numeric label, so no IP literal in any notation, and no local or special-use name), an optional port of 1–65535 without a leading zero, and an optional path. User info, a query, a fragment, `$`, `%`, `\`, whitespace and non-ASCII are refused. At most 2048 characters. The owner's own provider URL may carry its key in the path, so every RPC URL is treated as a secret: never logged and never returned, and a refusal carries a fixed code, never the URL. **Resolve time.** The read client takes the platform's fetch. In Node it is `@4thtech-io/node` `nodeRpcFetch`, which resolves the host for every request, refuses loopback, private, link-local and unique-local answers, and connects to the checked address itself (SNI, certificate and `Host` on the name), with no redirect and no proxy (the 04 §4 `fetch_file` machinery).
- **Read client.** One viem public client per chain over a fallback of HTTP transports: the user's URLs first, then the shipped ones. Each request has a timeout (default 10 s, at most 30 s) and bounded retries per URL (default 2, at most 3, back-off from at most 1 s) before the next URL. Requests never follow a redirect and send no credentials or referrer. Only read methods are sent (`eth_call`, `eth_getLogs`, block, receipt, balance and fee reads); signing, account and transaction methods are refused before any request, and the client type has no send method. Every rejection is a `ChainError` with a fixed code (`call_reverted`, `invalid_call`, `method_refused`, `rpc_timeout`, `rpc_unavailable`, `rpc_error`, `bad_answer`, `rpc_failed`) and no URL, path, query or server text. The read client holds no key; sending a transaction (direct mode) arrives with M1-4c. **No URL through the client object (proposed; owner confirms at merge; M1-4b, IR-M1-4a-2).** Callers get a frozen view of the viem client, not the client itself: every function, also in a namespace such as `token`, rejects with a `ChainError` and reports one to an `onError` callback; `transport` shows only the transport types, so no property path, JSON or inspect output reaches an RPC URL; and `extend` hands the extension the same view and returns one, so an extended client stays wrapped. `createReadClient` accepts only the platform's address-checked fetch, which carries a brand that only `nodeRpcFetch` sets (a registered symbol; ESLint refuses a `for` member, also aliased or computed, in production code elsewhere), and refuses the global `fetch` even when branded. A plain fetch would skip the resolve-time check. This guards against wiring mistakes, not against a malicious caller in the same process.
- **Calls.** Contract calls are encoded and read only through the client-safe ABIs (`occNotaryClientAbi`, `occFeeVaultClientAbi`). Admin, upgrade, module, integrator, maintenance and pending functions cannot be typed or encoded by the client.
- **Selection today.** `selectChain` picks the first supported chain with no user input, and honours an Advanced or tool `chain?` override only for a supported chain. The funded and cheapest-chain steps of §6.3 are `selectPayingChain` (M1-26, below); `selectChain` stays for callers that need a chain before any read, such as composing a read client.

The **supported-chain list** (all `ChainConfig` entries, including contract and token addresses) **ships with each client release** (D-40). It is never fetched at runtime from a 4thTech service, so a compromised server cannot redirect payments. New chains arrive with a release; overrides live under Advanced.

### 6.2 Responsibilities

- Build and EIP-712-sign `Record` / `Receipt` / `AgentCard` (hash parity with Solidity via shared test vectors). The Record builder draws a random 256-bit nonce and, when the Record has a recipient, a fresh 32-byte CSPRNG salt; it takes neither from its caller and exposes no salt derivation (04 §5, D-61). A self-note has commitment 0 and no salt. It refuses kinds outside 1–6 (D-86) and returns the record ID the Notary will compute (05 §3.3). Signing goes only through `KeyStore.sign712`, after a check that the typed data still hashes to the digest the builder returned (proposed; owner confirms at merge; M1-4a).
- **Pre-sign code check (G-47 option (a), D-66, FA-2; proposed, owner confirms at merge; M1-4a).** Before signing, read the signer's code. Code that is exactly a 23-byte EIP-7702 designator (`0xef0100` + 20 bytes) returns a typed error (`signer_delegated`), so the MCP does not present it as a key problem. The signer is not asked to sign and nothing is submitted. The limitation is in 04 §5; the contract fallback (M1-3l) lands before mainnet and supersedes this check for mainnet.
- **ERC-7739 smart accounts (FA-11; proposed, owner confirms at merge; hand-off M1-4a typed-data builders).** A smart account that uses ERC-7739 needs the client to build the nested typed-data signature around the `Record` or `Receipt`. Such signatures are several hundred bytes, which raises the calldata of a batch (the 2 048-byte signature bound in §7 allows for it).
- Quote fees (`OCCFeeVault.quote`) and show them in USD, with the protocol and integrator parts separate (12 §5). Every launch fee token is a USD stablecoin valued 1:1, so **no price endpoint is needed**. (Later, with native volatile coins, 12 §3.4: a USD price source with an "≈" display, never used on-chain.)
  **Quotes, credits and deposits (proposed; owner confirms at merge; M1-4b).**
  - *Offered tokens.* A token is priced, shown or deposited only when the chain's shipped config lists it and it passes the launch allowlist again: USDC or USDT with a contract address, or the native coin on Gnosis chain IDs only (D-46). Anything else is refused before any request (`fee_token_not_offered`).
  - *Quote.* `quoteFee` reads `quote(feeType, token, appId)` (appId 0 for official clients) and returns the three parts in base units and in USD, each rounded up to the micro-dollar. It fails closed (`bad_answer`) when `total` is not the sum of the parts, when appId 0 has an integrator part, or when the integrator part exceeds 10 × the protocol part (the contract's cap bound, 12 §5). The quote is display only; the signed `maxFee` bounds the charge (12 §4).
  - *Credits.* `readCredits` reads `creditsOf(payer, token)` for every offered token, USD rounded down; `readCreditsAcrossChains` reads all chains in parallel and lists a chain that fails as unavailable, without error text. Which chain pays is §6.3 (M1-26).
  - *Deposit (direct mode).* `buildDeposit` returns the calls for the payer's own account: an `approve` of exactly the amount, then `deposit(token, amount)`; for the native coin one `deposit(address(0), amount)` carrying the value. It signs and sends nothing (M1-4c) and never builds `depositWithAuthorization` (M1-3c).
  - *Direct-mode signing (proposed; owner confirms at merge; M1-4c-b).* Direct mode signs only through `KeyStore.signTransaction` (04 §8.1), which checks before any key is read and refuses everything else with `transaction_refused`: EIP-1559 only; a chain ID on the KeyStore's own allowlist, the launch testnets only (no mainnet); `to` required (no contract creation) and one of that chain's Notary, fee vault or an offered ERC-20 fee token; by selector only `notarizeDirect`, `notarizeBatch`, `acknowledge`, `acknowledgeBatch` (Notary), `deposit` and `withdraw` (vault) and `approve` with the vault as spender (fee token); `withdraw` only to the agent's own address (an owner-chosen recipient is a later owner action, I-4); value only on `notarizeDirect` and on a native `deposit`, where it equals the amount; capped value, calldata, gas and fee. The chain package's tests check the allowlist against the pinned contracts release and the shipped config. No MCP tool reaches it.
  - *Credit events (IR-M1-3b-1 I-2).* A vault event counts only when it comes from the configured vault address, is not removed or pending, decodes strictly, names an offered token and, for `Deposited`, `Withdrawn`, `Swept` and `IntegratorWithdrawn`, moves a nonzero amount. `readCreditHistory` asks only the vault address, for one payer, over at most 10 000 blocks.
- Choose chain and payment automatically (§6.3).
- Submit via submitter(s) with failover; fall back to direct mode if the agent has native gas.
- Watch for inclusion; update `proofs`/`receipts`.
- `verifyProofPack`: read `getRecord`, recompute hashes and commitment, check signatures, and, when a key is disclosed, decrypt only in the order of §8 (the envelope's hash, its `sig`, then the key commitment `aead.kc`, G-46).

### 6.3 Chain auto-detection and selection (D-40)

There is no chain choice in the default UX (02 F-51).

1. **Detect.** For the agent address, query `OCCFeeVault.creditsOf` (per fee token) and the allowlisted stablecoin balances (`balanceOf`) on every supported chain, in parallel through the configured public RPCs, with a short time budget and a short cache (e.g. 60 s). Native gas balance is also read for direct mode. A chain that does not answer in time is skipped for this attempt.
2. **Select** for each paid action:
   1. the **default chain** (policy `proofs.defaultChain`) if it is funded;
   2. otherwise the **cheapest funded** chain, by the USD fee quote for this action;
   3. otherwise `needs_credits`, with a top-up suggestion (agent address, amount in $) on the **cheapest supported chain**.

   "Funded" means credits covering the quote, or a stablecoin balance that can become credits through the gasless top-up (F-46, once available).
3. **Override.** The tools' `chain?` input (06 §2.4; served only on the Advanced tool surface, `agentlink mcp --advanced`, M1-36h, owner-confirmed 23 Oct 2026) and the Advanced settings can force a chain; nothing else in the UX names one.
4. **Record.** The chosen chain is stored with the proof and written into the proof pack (`chainId`, §8), so verification needs no setup.

Querying every chain reveals the (pseudonymous, already public) agent address to those RPC providers; users who mind can set their own RPCs.

**Selection rules (proposed; owner confirms at merge; M1-26).**

- *Detect.* `detectFunding` reads, for one payer and one action, on every selectable chain in parallel: the contract's quote and `creditsOf` for each offered fee token, and the token's `balanceOf` only where a gasless top-up exists for it (the token is marked `eip3009`, which needs M1-3c). Each chain has a time budget (default 4 s, at most 30 s); a chain that fails or is late is listed as unavailable by chain ID only, with no error text, and is skipped for this attempt. Bad input (payer, fee type, app ID, budget) is refused before any request, so it never looks like an outage. Native gas for direct mode is read with M1-4c.
- *Funded.* A fee token funds the action when its credits cover the quote (`payFrom: "credits"`), or, where the gasless top-up exists, when credits plus the balance cover it (`payFrom: "top_up"`) and the balance also covers the amount to add, which is at least the vault's `minDeposit(token)` (read with the balance; 12 §4.1). A balance without the gasless top-up never counts.
- *Order and tie-breaks.* The default chain (`proofs.defaultChain`, matched as a network family or an exact key: the family `base` matches `base-sepolia` and `gnosis` matches `gnosis-chiado` in this testnet release, so the policy never names a testnet; an unknown value is ignored) when funded; otherwise the funded option with the lowest USD quote; at an equal quote, credits before a top-up, then the lower chain ID, then the config token order. The result does not depend on the order the chains are given in.
- *Nothing funded.* `needs_credits` with a top-up route: chain, token, the amount to add in USD (the shortfall, fee minus credits in that token, and at least `minDeposit` where the gasless top-up applies), the action's fee in USD (`feeUsd`) and the agent address, on the chain with the lowest quote (same tie-breaks). The tool layer builds the top-up link (06 §2.1 `topUpUrl`) and the 11 §5 copy; the chain package returns codes and numbers only. When no chain answered, the result is `unavailable`, never `needs_credits`.
- *Override.* The Advanced or tool `chain?` override forces that chain: funded → that chain; not funded → `needs_credits` routed to that chain; unavailable → `unavailable`, never a silent switch. A chain this release does not offer is refused (`unsupported_chain`).
- *Testnet only.* A chain is selectable only when its config is a testnet and its chain ID is not a known public mainnet ID. Any other entry is never queried, picked or offered for a top-up, so its RPC never sees the agent address.
- *Cache.* `createChainSelector` reuses a detection for 60 s per payer, action, app and chain set (at most 32 entries), and only when it gave a funded selection: `needs_credits` and `unavailable` always read again, so credits added outside the client (a top-up link, the faucet) show on the next attempt, and a detection with an unavailable chain is never kept. The paid path (M1-4c) calls `clear()` after every paid action and after a refusal for missing credits, then selects again once.

---

## 7. Submitter (4thTech service, open source)

Cloudflare Worker; stateless except rate-limit counters (Durable Object). It never sees plaintext and cannot alter what it submits.

| Endpoint | Body | Behaviour |
|---|---|---|
| `POST /v1/notarize` | `{chainId, records: [{record, signature}]}` | Validate signature and credits via `eth_call` simulation; submit (batched when possible); return tx hash and record IDs |
| `POST /v1/receipt` | `{chainId, receipts: [{receipt, signature}]}` | Same for receipts |
| `POST /v1/deposit-authorization` | `{chainId, token, auth: EIP-3009 fields}` | Check `value ≥ minDeposit` and token EIP-3009 support; submit `depositWithAuthorization` (vault calls `receiveWithAuthorization`). Testnet, off by default (M3-4b-t-3; see the Wire notes) |
| `GET /v1/status/:txHash` | — | Inclusion status |
| `GET /v1/health` | — | Per-chain gas wallet balances, queue depth |

Requests and responses use the JSON form of 05 §3.1 (04 §2.4.1): `0x` + lowercase hex for addresses, `bytes32`, canonical ECDSA signatures and transaction hashes, and decimal strings for `uint256`.

- Gas wallets per chain (hot keys in Workers secrets, low balances, auto-alerts). Gas costs are recovered through protocol fees.
- Per-signer and per-IP rate limits; reject if simulated credits are insufficient.
- **Receipts (decided, D-114; built by M1-34-b).** The sender's proof fee covers up to 3 receipts per record: the submitter accepts up to 3 receipts for a record whose fee was charged, whatever the recipient holds, capped per record. If the submitter is unreachable, the receipt is queued locally and posted when possible (the proof stays valid with fewer receipts). A recipient is never charged without asking.
  - *Charged* (proposed, owner confirms at merge; M1-34-b) means the Notary stores the record: it stores a Record only in the call that charges its NOTARIZE fee (05 §3.3 notarize steps 3 and 4; batches are all-or-nothing). A receipt for a record the Notary does not store is refused. This needs no contract change while the NOTARIZE fee is above zero, as the deploy configuration sets it (12 §2, M1-14); a record stored while that fee was zero would count as charged.
  - The cap counts the types set on-chain and the types the submitter has in flight for that record. The contract already allows at most 3 (ACCEPTED and REJECTED are exclusive, 05 §3.3); the submitter's own cap bounds what it sends even when items race.
- Batches follow 05 §3.3 (G-4): all-or-nothing, except that items already on-chain in identical form are skipped. The submitter rule (per-item simulation, one resubmission without the failing items, per-item status `recorded`, `skipped` or `failed`) is there too.
- **Code-bearing signers (accepted, D-93; pre-audit AUDIT-FABLE-OCCv2-1 FA-1).** This rule MUST hold before the submitter (M1-10a) serves public beta traffic. A signer with code (an ERC-1271 account, including an EOA with an EIP-7702 delegation) is checked again at inclusion, and its answer there can differ from the simulated one. In an all-or-nothing batch, that one item would revert every other signer's items, and a fresh address can do this once each, so the reactive cooling-off in 05 §3.3 alone does not protect other signers.
  - An item whose signer (the Record's `signer` or the Receipt's `signer`) has code at simulation time is submitted **solo**: in a transaction that carries no other signer's items. This is the default.
  - A submitter MAY instead put **at most one** code-bearing item into a batch. If that batch reverts, the code-bearing item is taken as the cause, and the other items are resubmitted once without it (05 §3.3). This bounds each case to one lost batch and names the cause without a trace. It still costs the other signers one lost batch per fresh address, which is why solo is the default.
  - The cooling-off is **proactive** for code-bearing signers: it applies from their first item, not only after a revert. Contract and multi-signer (code-bearing) signers are therefore solo from their first item (D-93). The after-revert cooling-off (`soloAfterRevertSeconds`, 05 §3.3) still applies to every signer, because an address can gain code between simulation and inclusion. Per-IP limits stay.
  - Every transaction's gas limit is its simulated gas plus a fixed margin (a submitter setting), never a large default. An account that uses more gas at inclusion than in simulation then costs the submitter at most that margin.
  - Not adopted: a cooling-off per deploying address (suggested by the pre-audit). Accounts are usually deployed through shared factories, so it would penalise every honest account from the same factory, and it adds nothing once code-bearing signers are solo from their first item.
  - Contract side (M3-1a scope, a 05 §3.2 change): a bound on the gas forwarded to `isValidSignature`, **required** because G-47 option (b) is adopted (D-66). For EIP-7702-delegated EOAs, see gap G-47: the limitation is documented now, and the contract fallback (M1-3l) lands before mainnet.
  - **Residual (proposed, owner confirms at merge).** Any signer, with or without code, can still cost the other signers one lost batch per fresh address. The simplest way is to withdraw its credits between simulation and inclusion (05 §3.3 names this case). The solo rule, and G-47 option (b) with the gas bound, close only the code-bearing and EIP-7702 routes, not this one. The cost stays bounded by the one resubmission without the failing item (05 §3.3), the after-revert cooling-off and per-IP limits; it is a denial of the batch path, which I-3 allows, with no loss of funds and no forged record.
- **Items already on-chain (accepted, D-94; FA-3).** An item that simulation shows is already on-chain in identical form (05 §3.3: on-chain it would only be skipped) is not transmitted. The submitter reports it `skipped`, with the existing `recordId`, and leaves it out of the transaction; only items that are new at simulation time are sent. The on-chain skip still covers an identical item that lands between simulation and inclusion. For a receipt, "identical" is read as in 05 §3.3: the item's deadline, signature and commitment must pass in simulation, otherwise it is `failed`. Such items count against the per-IP limit, not against the signer's limit: anyone can resend a signer's public items, so counting them per signer would let a stranger use up an honest signer's limit.
- **Submitter defaults (D-94, FA-3; each is a setting).** 600 items per IP per hour; 120 new items per signer per hour (replays of items already on-chain count against the IP, not the signer); 24 hours retention of finished items; a 25,000 gas margin on each transaction's simulated gas; and a ceiling of 700,000 gas for any one item (`maxItemGas`), above which the item fails before anything is charged or sent. The 700,000 ceiling is lowered once the audited bound on the gas forwarded to `isValidSignature` lands (M3-1a), and the flat fee must cover that much gas at the worst-case gas price.
- Anyone can run a submitter (same code); clients accept a list.
- No request logging beyond aggregate metrics; never log signatures linked to IPs.
- **Privacy invariant (D-109; proposed, owner confirms at merge; OPS-PRIV-1).** The submitter learns nothing the chain does not publish, except who connects and when, and it keeps none of that:
  - It receives only signed Records and Receipts with their signatures. It never receives plaintext, envelopes, content keys, any private key, or a Record's salt before that Record's receipt; a receipt's salt is public on-chain once submitted (04 §5.1, I-1, I-2).
  - It never stores or logs a client IP address, raw or hashed, next to a signer or recipient address, a `recordId` or a transaction hash. Rate-limit keys stay separate (HMAC'd IP bucket; signer and chain) and expire with their window.
  - Cloudflare-side logging is off for the submitter and the faucet in every environment, as for the drop (`apps/drop/wrangler.toml`): Workers observability logs and traces, invocation logs, Logpush and Tail Workers. Only aggregate metrics with no address or IP remain. The deploy check of OPS-PRIV-1 fails the deploy when the deployed configuration turns any of these on, and the same rule applies to any relay 4thTech runs (D-75).
  - Direct mode (`notarizeDirect`) avoids the submitter entirely, at the cost of paying the network fee from the agent's own account (12 §4.2, §4.4).

**Implementation (in development, testnets only; proposed, owner confirms at merge; M1-10a).** `apps/submitter` is the Worker; its chain side is in `@4thtech-io/chain` (`createSubmitterChain`, `createSubmitterClient`, the wire parsers), so `apps/submitter` stays outside the viem zone (M0-10).
- **Wire.** Requests are parsed strictly in the JSON form of 05 §3.1: exact fields, 1–20 distinct items, signatures `0x` + lowercase hex of at most 2 048 bytes (ERC-1271 and nested ERC-7739 signatures are longer than 65 bytes, FA-11). A receipt item's ID is `<recordId>:<receiptType>`. Each item answer is `{id, recordId, status, txHash?, error?}` with `status` one of `submitted` (in a sent transaction), `held` (Notary paused), `recorded`, `skipped` or `failed`; `error` is the contract error name (`InsufficientCredits`, `InvalidSignature`, `Expired`, …) or a fixed code (`rate_limited`, `unavailable`, `reverted`, `not_included`, `gas_too_high`, `signer_refused`, `receipt_limit`). `GET /v1/status/:txHash` returns `{chainId, txHash, state: pending | included | reverted | dropped, items}` (also found by a replacement's hash) with each item's current status and transaction, so an item resubmitted after a revert shows its new `txHash`. Refusals are `{error}` with a fixed code: `bad_request` and `unsupported_chain` (400), `too_large` (413, body above 128 KiB, which fits 20 items with 2 048-byte signatures), `rate_limited` (429 with `Retry-After`), `unavailable` (503), `not_found` (404). `/v1/deposit-authorization` answers 501 `not_available` while the submitter's `SUBMITTER_DEPOSIT_AUTH_CHAINS` switch is unset (the default).
- **Gasless top-ups (M3-4b-t-3; proposed, owner confirms at merge).** `POST /v1/deposit-authorization` takes `{chainId, token, auth}`, `auth` being the `ReceiveWithAuthorization` fields in the 04 §2.4.1 JSON form plus the split signature `v`, `r`, `s`, and answers `{status: "submitted", txHash}`, or `{status: "failed", error, txHash?}` with a fixed code (`unsupported_chain`, `gasless_unavailable`, `not_vault`, `below_min_deposit`, `above_max_top_up`, `expired`, `invalid_window`, `invalid_signature`, `already_used` (409), `simulation_failed`, `gas_too_high`, `rate_limited` (429), `unavailable` (503); malformed bodies are `bad_request`, 400, and bodies above 2 KiB `too_large`, 413, in the same `{status: "failed", error}` form; only 405 and the switched-off 501 answer `{error}`). Testnet only (Base Sepolia); off unless the operator enables the chain. Before its relay wallet signs anything, the submitter checks the payee is the chain's fee vault, $5 ≤ value ≤ $50 and ≥ the vault's `minDeposit`, the window (15 minutes plus clock skew, at least a minute left), that the signature recovers an EOA `from` under the token domain read from chain, that the nonce is unused, and simulates the call within a gas cap. One authorization per transaction; idempotent on `(chainId, from, nonce)` (an identical repeat returns the same `txHash`, anything else under that nonce is `already_used`). Limits: 20 requests per IP and 5 top-ups per agent per hour (only authorizations that pass the checks count; a send that fails does not count), and 200 requests per hour across all IPs and agents that pass the parse, payee and window checks (M3-4b-t-T3-b; proposed, owner confirms at merge). The relay refuses `unavailable`, sending nothing, while more than 3 of its own transactions are pending (a stuck transaction), and records each authorization before sending it, so a crash mid-send never sends it twice. The relay pays the network cost from its own gas wallet, separate from the proof gas wallet; the normal deposit fee applies. The answer is untrusted: the agent confirms the credit by reading `creditsOf`.
- **Before sending.** The deadline, then the signature: an EOA signature must recover to the signer locally; a signer with code (ERC-1271, EIP-7702) is checked by the Notary in simulation. **Receipt allowance (D-114, M1-34-b):** before simulation, each record a receipt names is read once (`getRecord`). A record the Notary does not store was never charged: its receipts are `failed` with `RecordNotFound`. A new receipt type when the record already has 3 types set on-chain or in flight here is `failed` with `receipt_limit`; below that, ACCEPTED while REJECTED is set or in flight (or the reverse) is `failed` with `ConflictingReceipt`, so it never reverts a batch. A replay of a type already set goes on to simulation and reads as `skipped`. Nothing reads the recipient's credits or gas, and a refused receipt does not count against the signer's limit. A failed read answers `unavailable`. Then each item is simulated alone through `notarizeBatch`/`acknowledgeBatch` with one item (a receipt whose type is already set reads as `skipped`). **Per-item gas ceiling (IR-M1-10a-1 H-1):** an item whose own simulated gas is above `SUBMITTER_MAX_ITEM_GAS` (default 700 000: the planned 500 000 bound on the gas forwarded to `isValidSignature`, M3-1a, plus a notarize with credits and a reserve) is `failed` with `gas_too_high`, so an ERC-1271 account that burns gas cannot make the submitter pay for it. A batch's gas limit is its simulated gas plus the margin, and a batch that simulates above the sum of its items' own gas is split, so the limit never exceeds that sum plus the margin. An RPC error without revert data is the infrastructure's: the request answers `unavailable` or the item fails with `unavailable`, and no signer cools off. Transactions always use the batch functions, so an identical item that lands elsewhere before inclusion is skipped on-chain instead of reverting the transaction.
- **Rate limits.** Per IP (IPv6 per /64, keyed by an HMAC under a Worker secret, never stored raw): every item of a request, replays included, default 600 per hour. Per signer and chain: only items new at simulation, default 120 per hour; over the limit an item is `failed` with `rate_limited`. `/v1/status` and `/v1/health` are limited per IP too (`SUBMITTER_IP_READS_PER_HOUR`, default 600), and each isolate reuses a gas balance read for 10 s. An IP and a signer are never stored together.
- **Settings.** `SUBMITTER_GAS_MARGIN` (default 25 000 gas, at most 200 000), `SUBMITTER_SOLO_AFTER_REVERT_SECONDS` (3 600), `SUBMITTER_CODE_SIGNER_MODE` (`solo`, or `one-per-batch`), `SUBMITTER_MAX_BATCH` (20), `SUBMITTER_MAX_HELD_SECONDS` (86 400, from 300 to 604 800; below), and the two limits. Any invalid value makes the Worker refuse (`unavailable`). Secrets, set by the owner per environment and never in a file: `SUBMITTER_IP_KEY`, `SUBMITTER_GAS_KEY_<chainId>` and, optionally, `SUBMITTER_RPC_URLS_<chainId>`; a chain without its gas key is unavailable and nothing else is affected. Only supported testnets can be served.
- **After a revert (IR-M1-10a-1 M-1).** A solo transaction that reverts while its items still pass simulation is not resent: its items are `failed` (`reverted`) and the signer's new items are refused (`signer_refused`) for `soloAfterRevertSeconds`. Shared batches follow the one-resubmission rule of 05 §3.3; when no item can be named as the cause (every item still passes simulation), that one resubmission is split per signer, each signer's items in a transaction of their own, so one diverging signer cannot cost the others their resubmission (M1-10a-b). A chain read that fails while re-simulating keeps the item in flight (`held`, tried again next round); such a revert does not count toward the item's resubmission limit, and no signer cools off for it (M1-10a-b).
- **Stuck transactions (IR-M1-10a-1 M-2).** A transaction with no receipt after `SUBMITTER_STUCK_AFTER_SECONDS` (default 180) is replaced at the same nonce, same items and gas limit, with fees raised 25 % compounded each time, at most `SUBMITTER_MAX_REPLACEMENTS` times (default 3). After that it is `dropped`: its items are queued again (a fresh simulation reports any that landed as `skipped`) and the next nonce is the chain's `latest` one (`eth_getTransactionCount(…, "latest")`, mined transactions only; if that read fails, the given-up nonce; a send skips any nonce that a transaction still in flight holds), so neither a lost nonce nor a forgotten transaction still in some node's mempool leaves a gap that blocks later sends (M1-10a-b). Items stay subject to their deadline. `SUBMITTER_MAX_FEE_PER_GAS_WEI` (optional) caps every transaction's fee.
- **Held items (M1-10a-c; IR-M1-10a-b-2 L2).** A `held` item (Notary paused, or a chain read that failed) is tried again every round until its own deadline (`Expired`) or its intake deadline, `SUBMITTER_MAX_HELD_SECONDS` after the queue first took it, whichever comes first. Past the intake deadline it is `failed` with `unavailable`, so a deadline the signer set far ahead cannot keep it in the queue for good; the queue holds at most what the rate limits admit in that window. Asking again while it is in flight does not extend the intake deadline. The client reads the chain after any `failed` answer and may post the same signed item again later.
- **Queue and nonces.** One Durable Object per chain holds the gas wallet's nonce and every item in flight, and serialises all sends on that chain; an alarm polls sent transactions and held items. After a failed send it reads the pending nonce from the chain again. Finished items and transactions stay readable for 24 h.
- **RPC.** The Worker's RPC URLs pass the 04 §4 raw-string rule and are treated as secrets. It uses the Workers runtime fetch, not the Node address-checked fetch (`nodeRpcFetch`): those URLs are operator configuration, never inbound content, and the Workers runtime has no route into private networks. Deployment invariant: the submitter Worker has no VPC or Tunnel binding. Only read methods and `eth_sendRawTransaction` are sent; the transaction hash is computed from the signed bytes.
- **Client.** `createSubmitterClient` takes up to 5 submitter URLs (same URL rule) and the address-checked fetch, and fails over on network errors, timeouts, 5xx, 429, `unsupported_chain` and answers that do not parse; any other 4xx stops. Its answers are untrusted: M1-4c confirms every status by reading the chain. A receipt that no submitter takes is `pending`: `createProofSubmitter` sends a receipt in direct mode (from the agent's own account, which pays the network cost) only when the caller sets `directReceipts`, which no shipped client does, so a recipient is never charged unasked (D-114). The core keeps the signed receipt (`receipt_signed`) and posts the same bytes again on every sync pass, after that pass's new envelopes, at most 5 per pass, least recently tried first, each waiting at most 2 s for inclusion (the next pass reads the chain first), until they land or 04 §5 allows a replacement. A receipt the client's own simulation refuses for good (`RecordNotFound`, `InvalidSignature`, `NotRecipient`) leaves the queue (`receipt_failed`) (M1-34-b; IR-M1-34-b-1). `RecordNotFound` first gets one retry of the same signed bytes after a fixed 3 s, so a client RPC that lags behind the record's block does not fail the receipt for good; nothing is signed again and nothing is charged (M1-34-c; IR-M1-34-b-2).

---

## 8. Proof pack format (v1)

```jsonc
{
  "type": "agentlink.proof",
  "version": 1,
  "chainId": 8453,
  "notary": "0x…",
  "recordId": "0x…",
  "record": { /* Record struct fields, JSON form of 05 §3.1 */ },
  "signature": "0x…",
  "signer": { "evm": "0x…", "agentCard": { /* optional, card JSON form, 04 §2.4 */ }, "cardSig": "0x…" /* with agentCard, never alone: the owner's EIP-712 signature over it */,
              "cardAgentSig": "0x…", "cardPop": "<128 hex>" /* optional, together and only with agentCard: proof of possession, 04 §2.9, D-102 */ },
  "envelopeHash": "0x…",
  "envelope": { /* ciphertext envelope; optional, but required whenever disclosure is non-null */ },
  "recipient": { "evm": "0x…", "salt": "0x…" },          // optional disclosure
  "receipts": [ { "type": "DELIVERED", "signer": "0x…", "txHash": "0x…", "at": "…" } ],
  "disclosure": { "contentKey": "base64url" } | null,  // only if owner approved; the 32-byte CEK (04 §3.3)
  "ownerApproval": { "signed": { /* SignedOwnerAction, approval.decide */ }, "action": { /* commitment approval-request.action incl. context.scope */ } }
                 | { "standingRule": true, "policyHash": "<64 lowercase hex>" } | null,  // proof of agreement: included by default, owner may leave it out (04 §3.4, D-55)
  "exportedAt": "…"
}
```

**What sharing a pack reveals (D-109).** A pack always reveals the record, its signature and its receipts (so the recipient's agent address whenever a receipt exists). With `signer.agentCard` it also reveals the signer's agent profile: the owner's public keys, `nameHash` and the relay-list hash. With `envelope` (required whenever content is disclosed) it reveals the sender's message key, the envelope time, thread and size, and the key IDs of the recipient agent and both owners. `recipient` reveals the recipient and the salt; `disclosure.contentKey` reveals the whole content; `ownerApproval` reveals the owner's key and the approved fee cap (04 §3.4). The export summary (06 §2.4) and the user guide list these before the pack is shared.

Encodings follow 04 §2.4.1, and a verifier rejects a pack in any other form. `recordId`, `envelopeHash` and `recipient.salt` are `0x` + 64 lowercase hex. `recordId` and `salt` are the same strings as in the `proof` envelope body (04 §3.4), and `envelopeHash` the same as in a commitment scope (04 §3.4.2), so a value never has two spellings. `signer.cardSig` is `0x` + 130 lowercase hex under the canonical ECDSA rule of 04 §2.4.1. It is present exactly when `signer.agentCard` is, and a verifier rejects a pack with one and not the other. Without it the card cannot be verified (proposed, owner confirms at merge). `ProofStatus.fee.token` is `record.feeToken`; for a confirmed record `fee.amount` is the charged fee, at most `record.maxFee` (06 §2.4).

**Signer card and sender (proposed; owner confirms at merge; M1-4d-b, IR-M1-4d-1 M-1, IR-M1-4d-b-1).**
- *Card.* With `signer.agentCard`, the verifier requires that `cardSig` recovers the card's `ownerEvm` (04 §2.4), that `agentEvm` = `record.signer` and `ownerEvm` ≠ `agentEvm` (04 §2.9), and that `expiresAt` is 0 or later than the record's chain time. Otherwise it rejects the pack: `card_invalid`, or `card_expired`. The card's `issuedAt`, display name and relays are not checked against the record.
- *Sender.* After step 3 below, the envelope's `from` must equal the card's `agentNostr`. Otherwise the content is rejected (`sender_mismatch`) before the key is used. The result names the sender (`from`).
- *Attribution and verdict.* Content that passes every step is attributed to the record signer only after the card's proof-of-possession check (M1-4d-d, below). Otherwise it is reported as not attributed: `sender_not_bound` without a card, `card_pop_missing` with a card but without a valid proof of possession, or for a contract-account signer. `verdict` is `verified` only for attributed content; otherwise it is `record_only` when the record and receipts verify, and `failed` when the pack does not.
- *Proof of possession (M1-4d-d; D-102, decided by Tali in chat, 2026-10-19).* `signer.cardAgentSig` and `signer.cardPop` (04 §2.9) are present together or not at all, and only with `signer.agentCard`; any other combination is `malformed_pack`. When present, after the card checks above, `cardAgentSig` must recover the card's `agentEvm` under the canonical ECDSA rule (04 §2.4.1), and `cardPop` must verify under the card's `agentNostr` over `taggedHash("agentlink/card-pop/v1", sha256(JCS(card)))`. The rules:
  - A card without the two signatures: the pack stays valid, and content that passes every step stays `unattributed` with `card_pop_missing` (it replaced the interim `sender_attribution_pending` when the M1-4d-d verifier landed); verdict `record_only`. Until the core produces and carries both signatures (the producer change that follows M1-4d-d), packs it exports have none and report this code.
  - Either signature fails, including one made for a different card (a replay from another epoch, owner or key): the pack is refused with the fixed code `card_pop_invalid`, verdict `failed`, before any content step runs.
  - Both verify, the signer is not a contract account, and the disclosed content passes every step, including `from` = `agentNostr`: the content is attributed to the record signer, and the verdict is `verified`.
  - A record signer that is a contract account (ERC-1271) is not attributed through a card in this version: its content stays `unattributed` (`card_pop_missing`), verdict `record_only` (later card M1-4d-e).
  - `exportProofPack` (M1-7g) attaches the card of the envelope's key epoch with both signatures: its own, or a contact's as received in `handshake`, `handshake-ack` or `card-update` (04 §2.9), so a recipient-exported pack can verify; without them it attaches the card alone.
- *A contract account that no longer confirms (D-96).* When the record signer has code and its `isValidSignature` does not accept the pack's `signature` at verification time, the pack does not fail: the proof network checked the signature when it stored the record (05 §3.2), and the account may have changed its rules since. The result carries the non-fatal code `signer_no_longer_confirms` next to an unchanged verdict (`verified` or `record_only`), shown as "The signer's account no longer confirms this record. The proof network checked it when the record was made." An ECDSA signer whose signature fails stays `signature_invalid`.
- *Receipt flags (D-97).* The verifier reads `receiptFlags` with the 05 §3.3 layout (type `t` is bit `t − 1`). Each of bits 0–3 must be set exactly when `receiptAt[t − 1]` is non-zero, bits 4–7 must be 0, and bits 2 and 3 (ACCEPTED, REJECTED) must not both be set. Any mismatch is `malformed_record`, verdict `failed`.
- *Receipt links (M1-4d-c; D-104, D-105, decided by Tali in chat, 2026-10-19).* Each receipt stands on the `getRecord` read above (05 §3.3). The `txHash` a pack names for a receipt is checked with one transaction-receipt read (`eth_getTransactionReceipt`), never a log query. It is `confirmed` only when the transaction succeeded and carries the Notary's `ReceiptRecorded` event, emitted at the configured Notary address for this chain, with this `recordId`, receipt type, signer and time (`receiptAt`). `ReceiptSkipped` and any other event are never evidence. A transaction the chain does not show, an answer that is not a transaction receipt, or a read that fails is `not_checked`. A transaction that does not record the receipt (including a failed one) is a mismatch: the result carries the non-fatal code `receipt_tx_mismatch` next to an unchanged verdict, shown as "The proof's link for a receipt does not lead to that receipt. The receipt itself is on the proof network." A `txHash` is shown or linked only when `confirmed`; an unconfirmed hash is never shown as a link (11 §6.4).

**Owner approval (M1-4d-c; D-104, decided by Tali in chat, 2026-10-19).** `ownerApproval` (04 §3.4, D-55) is checked after the record, card, receipts and content steps, and never changes the verdict on its own. `null` is reported as no approval. A standing rule is reported with its `policyHash`; the policy document is not in the pack, so the hash is not checked. A signed approval is checked in this order, fail closed; any failure refuses the pack with the fixed code `owner_approval_invalid`, verdict `failed`, shown as "The owner approval in the proof is not valid for this record.":
1. **Signature.** `signed.sig` is BIP-340 by `signed.body.owner` over `taggedHash("agentlink/owner-action/v1", sha256(JCS(body)))` (04 §2.5.1).
2. **Action.** `body.params.actionDigest` = sha256(JCS(`action`)), so the owner signed exactly this action, scope and terms (04 §3.4.1).
3. **Terms.** The scope's `termsHash` is the hash of the stored terms in `action.context.terms` (04 §3.4).
4. **Scope bound to this record (04 §3.4.2).** The approving agent is either the record signer or its recipient; otherwise the approval is refused.
   - *Recipient side* (the scope's `counterparty.agentId` is the record signer): the decision fits the record kind (`accept` on an OFFER, `confirm` on an ACCEPT, `reject` on either); the record has a recipient commitment; `answers.envelopeHash` = the record's `envelopeHash`; a disclosed `recipient.evm` equals the scope's `agentId`. The scope names the record's envelope, so it is reported `recordBound: true`.
   - *Signer side* (the scope's `agentId` is the record signer): `offer` on an OFFER record or `accept` on an ACCEPT record; `notarize` is true; a disclosed `recipient.evm` equals the scope's counterparty. The scope names no record, so it is bound only through opened content: when the content opened, the payload type is `offer` or `accept` to match, the payload's terms hash to the scope's `termsHash`, and an `accept`'s `replyTo` equals `answers.envelopeId`; any mismatch refuses the approval. Without opened content the approval is reported with `recordBound: false`: genuine, but possibly for another record of the same signer, and never shown as approving this record.
5. **Owner key.** When the pack carries the signer's card, the owner key it names (`ownerNostr`) must agree: it is `body.owner` when the signer approved, and the scope's `counterparty.ownerKey` when the recipient did. The result says `ownerBound: true` only when the signer approved and the card names the signing key; a recipient's approval is never owner-bound by the pack alone.

The expiry and nonce checks of 04 §2.5.1 applied once, when the core used the approval, and are not repeated. The result reports the approver side, decision, `termsHash`, version, the signing owner key, `ownerBound` and `recordBound`.

**Availability.** The receipt-link and owner-approval rules above are implemented in the M1-4d-c verifier (4thtech/agentlink#301).

**Disclosed content key (G-46; D-66).** A pack with a disclosed key must let any verifier reach the one plaintext that every party to the envelope read (04 §3.3):
- **Shape.** When `disclosure` is non-null, `envelope` must be present; otherwise the verifier rejects the pack. `contentKey` is the envelope's CEK, exactly 32 bytes, never the derived payload key. Any other length is rejected. Only the CEK can be checked against `aead.kc`.
- **Verifier order, fail closed.** Each step must pass before the next one runs:
  1. Parse `envelope` strictly (04 §3.1.1 step 3).
  2. Recompute `envelopeHash` from it. It must equal the pack's `envelopeHash` field and the hash in the on-chain Record (`getRecord`): three values, one hash.
  3. Verify `sig` under `from` with the envelope tag (04 §3.1.1 step 4).
  4. Derive `kc` from `contentKey` and compare it with `aead.kc` (04 §3.3).
  5. Decrypt.
  6. Apply the payload's strict schema (04 §3.4) before anything is shown.
- **Rejections.** A key that fails `kc`, or that passes AES-GCM but not `kc` (a two-key ciphertext), is rejected, never shown as a partial result. A failure at any step means that the pack proves no content. The record and its receipts are still verified on their own.
- **Optional counterparty check.** With the disclosed CEK, a verifier that also holds the counterparty's card (out of band; the pack carries only the signer's card) may recompute that party's entry (04 §3.3, wrap check). This confirms that the counterparty's entry carried the same CEK. It is optional, and the pack format does not change for it.
- **Export.** `exportProofPack` (M1-7g) always includes `envelope` when it discloses a key.

**Recipient-side export (D-107; decided by Tali in chat, 2026-10-19; card M1-7g-b).** Either side of a record can export its pack (02 J8 step 6). The recipient builds it from the signed Record and signature that arrived in the `proof` body and passed the receive checks (04 §3.4); it never builds one from the chain read alone, which lacks the Record fields that only `recordStructHash` commits.
- **Fields.** `record` and `signature` exactly as stored; `recordId` and `chainId` from the body; `envelopeHash` = `record.envelopeHash`; `notary` = the recipient's own configured Notary for `chainId`, never a value from the body.
- **Signer.** The contact's card for the envelope's key epoch, with its `cardSig`, and with `cardAgentSig` and `cardPop` as received in `handshake`, `handshake-ack` or `card-update` (D-102, M1-4d-f); without them, the card alone (`card_pop_missing` at verification); without a stored card for that epoch, `{evm}` only.
- **Recipient.** Left out by default. Only with `includeRecipient: true` does the pack carry `recipient: {evm, salt}` with the recipient's own agent address and the salt, the same default and option as on the sender side (M1-7g). Including it links the recipient's agent address to the record for whoever receives the pack (05 §3.3, privacy note).
- **Content key.** As on the sender side: only with `proofs.allowKeyDisclosure` and the owner's approval (06 §3), and then always with `envelope` and the 32-byte CEK, which the recipient unwraps from its own entry (04 §3.3).
- **Owner approval.** By default the exporting side's own signed approval (04 §3.4, D-55), which here is the recipient's. The verifier checks it with the owner-approval rules above (D-104), step 4 *Recipient side* and step 5. The owner may leave it out.
- **Receipts.** The recipient's own receipts for the record, listed only with a transaction hash it holds; the verifier reads every receipt from the chain in any case.
- **Unavailable.** A received proof without a stored Record and signature (an older sender, 04 §3.4), or a stored pair that does not form a valid pack, returns `rejected` with code `RECORD_UNAVAILABLE` and builds nothing.

**Interim sender-attribution rule (D-95).** Until agent-card proof-of-possession lands (its own S2 card, M1-4d-d, specified above), a pack whose sender attribution relies on a card reports `record_only`, not `verified`. The record, its signature and its receipts are still verified on their own. The result says in neutral words that the record exists and that the sender is not confirmed by the pack; it makes no claim about who the sender is.

---

## 9. Node KeyStore backends (D-54)

`@4thtech-io/node` ships two backends behind the same `KeyStore` interface from `@4thtech-io/crypto` (04 §3.1.1, G-2): the **OS keychain**, which is the default (04 §2.2), and the **passphrase-locked file KeyStore** for headless machines, which is opt-in (04 §2.8). Formats, KDF parameters, the owner-key rules, the threat model and the required tests are in 04 §2.8. This section covers runtime behaviour. Neither backend weakens `OwnerKeyStore` (04 §2.5).

### 9.1 Selection and the recorded backend

| Situation at `init` | Result |
|---|---|
| The OS keychain probe succeeds | Keychain. `--keystore file` is refused: "This machine has a system keychain. AgentLink uses it." There is no flag to force file mode (04 §2.8; proposed, owner confirms at merge) |
| The probe fails or times out | Treated as no usable keychain. The message also says how to fix the keychain, for example `security unlock-keychain` over SSH on macOS |
| No usable keychain, no opt-in | `needs_setup` (reason `no_keychain`); nothing is written |
| No usable keychain, `--keystore file` or "yes" to the question, in an interactive terminal with no harness marker set | File KeyStore at `~/.agentlink/keystore/<agentId>.alks`. Agent identity only; the owner step is separate (§9.3) |
| No usable keychain, opt-in without a TTY or with a harness marker set | `needs_setup` (reason `no_keychain`), naming the command the user runs in their own terminal. This is a UX guard; a faked terminal gets past it (04 §2.8) |

`init` records the backend in the agent's local config (`keyStore: "keychain" | "file"`). Every later start uses only the recorded backend: no fallback, no switch and no new identity when the other backend appears or the file is missing. Moving an agent between backends goes through `backup export` / `restore` (†, 06 §8, M1b; 04 §2.3.3, step 4: restore uses the backend this machine selects); a dedicated move command is out of scope for now. The recorded value is not owner-signed. Changing it can only make the agent fail to start; it can never weaken the key protection.

### 9.2 Unlocking a file KeyStore

| Source | Where | Notes |
|---|---|---|
| `AGENTLINK_KEYSTORE_PASSPHRASE_FILE=<path>` | MCP server and CLI | Recommended. A secret mounted at run time (Docker or Kubernetes secret, tmpfs, host secret store), never inside the image, a committed `devcontainer.json` or the persisted home directory. Opened and checked per 04 §2.8 |
| `AGENTLINK_KEYSTORE_PASSPHRASE=<value>` | MCP server and CLI | Allowed for Codespaces and CI-style secrets, and weaker (04 §2.8; proposed, owner confirms at merge). `init` and the harness config writers never write it, and `doctor` always warns when it is set. Deleting it from `process.env` does not remove it from `/proc/<pid>/environ`, the parent processes, `docker inspect` or config files |
| Interactive prompt (no echo) | CLI in a terminal only | Never on the MCP stdio channel. No CLI argument takes the passphrase |

- **Order.** The file source is tried before the environment variable. If both are set, the server uses the file and `doctor` warns. The server deletes both variables from `process.env` after reading.
- **Harness config.** The harness passes the path to the MCP server in its MCP config, for example `claude mcp add agentlink -e AGENTLINK_KEYSTORE_PASSPHRASE_FILE=/run/secrets/agentlink -- npx -y @4thtech-io/agentlink mcp`. The path is not a secret.
- **Async unlock.** The server answers MCP `initialize` first and then runs the KDF asynchronously. Until the unlock finishes, tools return `needs_setup` (reason `keystore_locked`, "unlocking").
- **No working source.** Every tool returns `needs_setup` (reason `keystore_locked`), and no other tool runs.
- **Owner passphrase.** No source exists for it. `OwnerKeyStore` reads the owner code only from an interactive prompt or uses a passkey (04 §2.5, §2.8). `AGENTLINK_OWNER_*` variables are ignored, and `doctor` warns if one is set.

### 9.3 CLI surface

```
agentlink init --keystore file             # opt-in; interactive terminal only; agent identity only (06 §7)
agentlink owner init                     † # owner key on a file-KeyStore machine (and on keychain machines until M1b, 04 §2.2): generated owner code; run it yourself (04 §2.8)
agentlink owner change-code              † # replace an exposed owner code with a new generated one; asks for the current one; same owner (04 §2.8, M1-9z; proposed, owner confirms at merge)
agentlink keystore passphrase              # change the unlock code or passphrase; asks for the current one at the prompt
agentlink doctor                           # backend, unlock source, owner-key location and their warnings
```

- **Secrets stay out of output.** The CLI and the MCP server never print, log or return a passphrase or code (I-7), with one exception below.
- **One-time display.** A generated code is shown exactly once, on the terminal. The user re-types its last group, and the screen is then cleared. For the **agent unlock code only**, `init` also offers to write the code to a path the user names (`O_CREAT | O_EXCL | O_NOFOLLOW`, mode 0600, refused under `~/.agentlink`), for example a file their container's secret store will mount.
- **Owner setup.** On a file-KeyStore machine the agent stays `needs_setup` (reason `owner_missing`) until `owner init` has run. `owner init` follows the rules in 04 §2.8:
  - it refuses if an owner already exists, and never overwrites;
  - it shows the owner fingerprint;
  - it only displays the owner code, never writes it to a file;
  - it states what a lost code means.

  `doctor` shows the owner fingerprint and when the owner key was created. M2 default (proposed; owner confirms at merge): the owner key is linked from the owner's own device (console) instead, and `owner init` on the headless machine becomes an explicit opt-in.

### 9.4 What the user is told (11 §5)

No "wallet", "seed phrase", "private key" or "encryption key" in default output. Proposed strings for the design pass (string keys per 11 §5.4):

| Moment | Copy |
|---|---|
| `needs_setup` `no_keychain` (agent relays it) | "This machine has no system keychain (common in containers, WSL and SSH sessions), so AgentLink can't protect your agent's identity here yet. To keep it in a passphrase-locked file instead, run `agentlink init --keystore file` yourself, in your own terminal." |
| Opt-in question | "No system keychain found. Keep this agent's identity in a passphrase-locked file? It's weaker than a keychain: anyone who gets both the file and its passphrase can act as your agent. Your approvals stay protected by your owner code, as long as you set it up yourself. [y/N]" |
| Unlock-code choice | "Use a generated unlock code (recommended) or your own passphrase?" |
| Generated code, shown once | "Your unlock code: {code}. Put it in your password manager or your container's secret store, not in your project files. Type its last four characters to continue." After confirmation the screen is cleared |
| Losing the code (M1a) | "If you lose this code, this agent can't be unlocked. Until backups are available, you'd set up a new agent and pair again." From M1b: "…restore this agent from your backup (`agentlink backup export`)", offered right after `init` |
| Own passphrase too short, or equal to an owner or agent secret | "Use at least 12 characters." · "Use a different passphrase from your owner code." |
| `owner init`, before the code | "Store this owner code off this machine, for example in your password manager. Without it, nobody can approve for this agent or remove it, and until backups are available you'd have to set up a new agent and pair again." From M1b, the last part reads: "…you'd restore it from your recovery kit." |
| `owner init`, after the code | "Owner set up. Your owner fingerprint: {fingerprint}. Check that `agentlink doctor` shows the same one." |
| `owner init` when an owner exists | "This agent already has an owner ({fingerprint}). AgentLink won't replace it. To use an owner from another device, link it from that device." |
| `doctor`, owner | "Owner: {fingerprint}, set up {date}. If you never saw an owner code yourself, this owner isn't yours: replace the agent." |
| Owner step needed (`owner_missing`, agent relays it) | "One step left, and you must do it yourself: run `agentlink owner init` in your own terminal. Don't let your AI run it or see the code it shows. It's what stops any AI, including your own, from approving its own actions." |
| `owner change-code`, before the new code (M1-9z, proposed) | "This replaces your owner code with a new one. Your owner fingerprint stays the same, and your agents keep their cards." Then: "Store this new owner code off this machine, for example in your password manager. Keep your current owner code too until this finishes. Never type either into a chat or let your AI see them." |
| `owner change-code`, after the new code (M1-9z, proposed) | "Owner code changed. Your old owner code no longer works, so you can now discard it. Your owner fingerprint is still {fingerprint}." · "If you saved a recovery kit, it isn't changed: it still restores this owner with its own recovery code." |
| Changing the unlock code | "Changing the unlock code doesn't protect copies of the file made earlier (backups, image layers, snapshots). If the code or the file leaked, replace the agent." |
| `needs_setup` `keystore_locked` (agent relays it) | "AgentLink can't unlock your agent's identity on this machine. Set AGENTLINK_KEYSTORE_PASSPHRASE_FILE to the file that holds your unlock code, then restart your AI app." While unlocking: "AgentLink is starting up. Try again in a few seconds." |
| `doctor`, file backend | "Agent identity: passphrase-locked file (no system keychain). Unlocked from: secret file." |
| `doctor` warnings | "Unlocked from an environment variable, which leaks more easily than a secret file." · "The unlock code is stored on the same disk as the file, so a copy of this disk is not protected." (shown when the passphrase file is on the same filesystem as the keystore and not on tmpfs) · "Your owner key is on this machine. Approving from your own device is safer." · "AGENTLINK_OWNER_PASSPHRASE is set and ignored: approvals always ask in your terminal." |
| `backup export`, before the code (M1-9i, D-115; proposed) | "This recovery kit restores your agent, its contacts and its history on another computer. Anyone with the kit and its recovery code can act as your agent and read its history, so keep them apart: the kit in your backups, the code in your password manager." With `--identity-only`, "and its history" is left out |
| `backup export`, the code (M1-9i, D-115; proposed) | "Your recovery code: {code}. It's shown only this once and only opens this kit. Type its last four characters to continue." After confirmation the screen is cleared |
| `backup restore`, before the code (M1-9i, D-115; proposed) | "This recovery kit belongs to owner {fingerprint}. Enter its recovery code to see which agents it holds." Then, after the agents are listed: "Restore these agents on this computer? [y/N]" |
| `backup restore`, after (M1-9i, D-115; proposed) | "Restored. Your owner fingerprint: {fingerprint}. Stop the agent on your old computer now: two running copies act as the same agent. If you used your own storage, connect it again with `agentlink storage connect`." |
| `backup restore` refused (M1-9i, D-115; proposed) | "An agent with this identity is already on this computer. AgentLink won't replace it." · "This computer has a different owner. Restore into a new user account or on a clean computer." |
| `storage connect` (M1-9i, D-115; proposed) | "Paste the access key ID and secret access key for this bucket. They stay on this computer and are never shown again." · After the test: "Your storage works. Files too large to send inside a message now go to your own bucket." (true under `files.storage: auto` and `own`, §5.6; under `drop` it adds: "Your rules still send them through the encrypted drop.") |
| `storage disconnect` (M1-9i, D-115; proposed) | "Your own storage is disconnected and its access key is removed from this computer. Files you already sent stay in your bucket until their links expire." |
| Own storage broken (`needs_setup` `storage_broken`, agent relays it; M1-9i, D-115; proposed) | "Your own storage isn't working on this computer, so I didn't send the file. Run `agentlink storage connect` in your own terminal to connect it again." |
| Approval needed on a headless machine (M1a) | "Approval needed. In your own terminal, run `agentlink approve {approvalId}`. Your AI can't approve for you." |
