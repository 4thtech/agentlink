# 07 — SDK, Transport and Storage

All packages live in the public `agentlink` monorepo (see 09). Every package must run in **Node (LTS)**, **modern browsers** and **Cloudflare Workers** unless marked otherwise. No Node-only APIs in shared packages (use `globalThis.crypto`, `fetch`, `Uint8Array`).

---

## 1. Package map

| Package | Depends on | Exposes |
|---|---|---|
| `@agentlink/types` | — | Shared types, zod schemas, constants (kinds, receipt types, fee types) |
| `@agentlink/log` | — | Redacting structured logger used by every package (04 §8 rule 4, I-7); secret-canary test helper (`@agentlink/log/testing`) |
| `@agentlink/crypto` | noble, hpke | Key derivation, HPKE seal/open, AES-GCM, STREAM file encryption, hashing, JCS, BIP-340 sign/verify, EIP-712 helpers |
| `@agentlink/chain` | viem, types, crypto | Chain configs, contract ABIs, fee quotes, credits, record/receipt building, submitter client, proof verification |
| `@agentlink/transport-nostr` | nostr-tools, types, crypto | `Transport` implementation: relay pool, gift wrap/unwrap, subscriptions, sync cursors |
| `@agentlink/storage` | types, crypto | `StorageAdapter` interface; `inline`, `drop` (default, D-48) and `s3` adapters (P0); `gdrive`, `dropbox`, `onedrive` connectors (P1, M2, D-49); `ipfs-pinning` (P2); storage selection (§5.6) |
| `@agentlink/core` | all above | `AgentLinkClient`: identity, contacts, envelopes, threads, files, proofs, policies, approvals; `KeyStore`, `Store`, `ApprovalChannel` interfaces |
| `@agentlink/node` | core | Node implementations: keychain `KeyStore` and the opt-in passphrase-locked file `KeyStore` for headless machines (§9, D-54), SQLite `Store`, local approval server (Node only) |
| `@4thtech/agentlink` | node, core | CLI + MCP server (stdio) (Node only) |

Integrators use `@agentlink/core` directly (with their own `KeyStore`/`Store`) and pass their `appId` to earn integrator fees.

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

Every mutating call runs: **policy check → (approval) → action → store → result**. Policy evaluation is a pure function `evaluate(policy, action, context) → allow | approval | deny` with unit tests for every rule.

### 2.1 Commitment flow (D-55)

`respondToTerms` and `proposeTerms` (for a firm offer) follow 04 §3.4.2:

1. **Load.** The core reads the answered envelope from its store. It runs the 04 §3.4 checks: canonical form, newest version of its negotiation (key = `termsId` plus the two parties, chain computed from its own store, no forks), within `validUntil`, own agent in `parties`. It then builds the `CommitmentScope` from stored data only, with `createdAt` and `expiresAt` fixed now; the scope never changes afterwards. A new scope for the same answered envelope voids an older pending one (one live scope, 04 §3.4.2).
2. **Evaluate.** `evaluate(policy, {kind: "commitment", scope}, context)` returns one of three results:
   - `deny`: the call returns `rejected`.
   - `allow`: the core stores a policy grant with the policy document's hash. The grant is a ledger row, not authority: before each part runs, the core evaluates the verified policy again and requires `allow` for this scope.
   - `approval`: the core stores a pending approval with the scope and its digest, and the call returns `pending_approval`.
   A proof approval needed by the same call joins the same request.
3. **Run.** On the retry with `approvalId`, the core verifies the owner-signed approval against the stored scope's digest and checks the void rules. It then runs the parts that have not run yet: send the `accept`, then record it if `notarize` is set and the offer has no record, then sign the receipt if the offer's record is known. Each part is claimed atomically: in one store transaction (SQLite, or Durable Object storage) the core checks that the part is unused (compare-and-set), marks it used and stores the signed item (envelope, record or receipt), and only then publishes it. A concurrent retry finds the part claimed and runs nothing. After a crash it republishes the same signed item rather than making a new one, and receivers and the contract deduplicate it by envelope ID, record nonce or one-time receipt flag.
4. **Deferred receipt.** When `syncInbox` processes a `proof` envelope (background loop or `agentlink_inbox`, never the read-only `agentlink_status`), it checks the record on-chain (M1-7g). It then looks up an open `accept` scope whose `answers.envelopeHash` equals the record's `envelopeHash`, where the record's kind is `OFFER`, its signer is the scope's `counterparty.agentId` and its recipient commitment opens to this agent. It rechecks void rules 2–6 (04 §3.4.2) and, for a grant, re-evaluates the policy. Only then does it claim the receipt part, sign `ACCEPTED` and submit it. Otherwise it signs nothing, and the activity feed says why.
5. **Expire.** At `expiresAt`, open parts are marked void and nothing more runs for that scope.

`evaluate` stays pure; the scope, grants and parts used live in the `approvals` table (§3).

---

## 3. Local store schema (SQLite; Durable Object uses the same schema)

| Table | Key columns |
|---|---|
| `identity` | agent_id, agent_card_json, key_epoch, created_at |
| `contacts` | contact_id, name, agent_card_json, owner_fingerprint, verified, status (active/blocked), created_at |
| `invites` | invite_id, proof_key (encrypted at rest; never the raw secret, 04 §3.6), label, expires_at, used_at |
| `envelopes` | envelope_id, thread_id, direction, contact_id, type, created_at, envelope_json (ciphertext), payload_json (decrypted, optional per setting), read_at |
| `files` | envelope_id, idx, name, size, sha256, locator, url, file_key (encrypted at rest with a keychain-held local key), expires_at, deleted_at |
| `proofs` | envelope_id, chain_id, record_id, tx_hash, status, fee_token, fee_amount, salt, created_at |
| `receipts` | record_id, type, signer, tx_hash, at |
| `approvals` | approval_id, action_json, scope_json (commitments, D-55; immutable after creation, carried in `action.context.scope`, 04 §3.4.2), answers_envelope_id (at most one live scope per value), source (owner \| policy grant, with policy hash), signed_decision (the owner's `SignedOwnerAction`; re-verified on every use, `status` is only a cache, 04 §2.5.1), parts_used_json (accept envelope ID, record ID, receipt record ID; claimed by compare-and-set), summary, status (pending \| approved \| denied \| expired \| cancelled \| void), expires_at, created_at, decided_at |
| `policies` | key, value_json, updated_at |
| `sync_cursors` | relay_url, last_seen |

**At rest:** all sensitive columns (decrypted payloads, contact names, file names, URLs, file keys, salts, invite proof keys, policies' parameters) are encrypted with a local **store key** (random, kept in the keychain, or in the file KeyStore on headless machines, §9). Non-sensitive columns (IDs, timestamps, statuses) stay in clear for indexing. Without the store key, the database reveals only activity timing and counts.

---

## 4. Transport

### 4.1 Interface (transport-agnostic)

```ts
interface Transport {
  publish(envelope: Envelope, recipients: NostrRecipient[], keys: KeyStore): Promise<PublishResult>; // one gift wrap per recipient key
  subscribe(keys: KeyStore, onEnvelope: (e: Envelope, meta) => void): Unsubscribe;
  sync(keys: KeyStore, since: number): Promise<Envelope[]>;
}

// KeyStore (03 §3) exposes the secret-key operations the transport needs:
//   signNostr(event), nip44Encrypt(peerPubkey, plaintext), nip44Decrypt(peerPubkey, ciphertext), hpkeOpen(wrapped)
// Seal signing uses the agent key; gift-wrap encryption uses a fresh ephemeral key created inside @agentlink/crypto.
```

An XMTP adapter (P2) implements the same interface; envelopes are unchanged.

### 4.2 Nostr implementation

- **Wrapping:** NIP-59 gift wrap (kind 1059) of a NIP-59 seal (kind 13) containing an unsigned rumor (kind 14, tag `["agentlink","1"]`, `content` = envelope JSON). NIP-44 v2 encryption. Randomized `created_at` per NIP-59.
- **Relays:** each agent card lists 3–5 relays (default: a curated set of reliable public relays + the optional 4thTech relay). Publish to the **recipient's** relays and the sender's own relays. Relay URLs from cards, invites and bodies are inbound content. They pass the raw-string relay URL schema at parse (04 §4, relay URLs).
- **Relay connections (M1-5; proposed, owner confirms at merge).** These rules close DNS rebinding and SSRF at connect time, on runtimes that control their own sockets (Node; the desktop app):
  1. Resolve the validated host string (A and AAAA).
  2. Accept the relay only if **every** resolved address is globally routable. Any other address skips the relay, and the activity log names it without the address.
     - **IPv4:** not in any block that the IANA IPv4 Special-Purpose Address Registry marks as not globally reachable. This includes `0.0.0.0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16`, `172.16/12`, `192.0.0/24`, `192.168/16`, `198.18/15`, `224/4` and `240/4`, plus `255.255.255.255`.
     - **IPv6:** inside `2000::/3`, outside every block that the IANA IPv6 Special-Purpose Address Registry marks as not globally reachable, and outside the blocks that embed IPv4 addresses: `2002::/16` (6to4), `2001::/32` (Teredo), `64:ff9b::/96` and `64:ff9b:1::/48` (NAT64). IPv4-mapped (`::ffff:0:0/96`), `::/128` and `::1` fall outside `2000::/3`.
  3. Open the TCP connection to the **checked address itself**, never to the host name again. TLS SNI, certificate verification and the HTTP `Host` header use the host name.
  4. Never follow a redirect on the upgrade, and repeat steps 1–3 on every reconnect.
  5. Ignore `HTTPS_PROXY`, `ALL_PROXY` and similar settings for relay connections: a proxy would resolve the name itself and bypass the check. A proxy option is a later owner decision.

  **Residual risk.** A browser `WebSocket` (the console) cannot resolve or pin an address. There, the schema rule and the platform apply: browsers enforce Private Network Access where it has shipped, and Workers cannot open connections to private addresses. M1-5 tests the steps above with a stub resolver: a rebinding answer, a mixed public and private answer, a 6to4 answer and a NAT64 answer are all skipped.
- **Delivery reliability:** publish to all listed relays, consider sent when ≥ 2 acknowledge (`OK`). Retry with backoff for up to 24 h from the local outbox.
- **Sync:** `REQ` with `#p` = own Nostr pubkeys, `kinds: [1059]`, `since = lastSync − 48 h` (NIP-59 randomizes gift-wrap timestamps up to 2 days back, so `created_at` cursors alone miss messages). Deduplicate by envelope ID (keep a seen-set for ≥ 7 days). Support **NIP-42 AUTH**, since many DM relays serve kind 1059 only to the authenticated recipient.
- **Size:** envelope ≤ 24 KB serialized; inline files ≤ 12 KB; check the final gift-wrap size against each relay's NIP-11 `max_message_length` and skip relays that cannot carry it.
- **Relay retention:** public relays may drop events; agents should sync at least daily. The optional 4thTech relay keeps gift wraps for 30 days (it only ever sees ciphertext).
- **Owner copies:** the owner console subscribes with the owner Nostr key and receives copies of all envelopes for its agents.

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
type StoredObject = { kind: string; locator: string; size: number; sha256: string };
```

### 5.2 S3-compatible adapter (P0)

- Works with Cloudflare R2, AWS S3, Backblaze B2, Hetzner Object Storage, Scaleway, Wasabi, MinIO.
- Uses `aws4fetch` (SigV4 over `fetch`) so it runs in Node, browser and Workers.
- Object key: `agentlink/<agentId>/<random 128-bit>` (no file names, no contact info).
- Multipart upload for files > 64 MB; streaming encryption so large files never fully load into memory.
- Presigned GET valid until `expiresAt` (max 7 days per SigV4; shorter with temporary credentials). The recipient can ask for a fresh link (`request` envelope, `kind: refresh-link`); the sender's core answers when online.
- Lifecycle: the CLI's `storage connect` offers to set a bucket lifecycle rule deleting `agentlink/` objects after 30 days as a safety net.
- Credentials (access key ID + secret) stored in the OS keychain (local) or Worker secrets (cloud). Recommended: a bucket-scoped key with only `PutObject`, `GetObject`, `DeleteObject`.
- **Guided setup** (`agentlink storage connect` and local UI): provider picker → step-by-step instructions with links → test upload/download/delete → save.

### 5.3 Inline adapter (P0)

Files ≤ 12 KB are base64url inside the payload; no storage needed.

### 5.4 Encrypted drop adapter and service (P0, D-48)

The default store for files over 12 KB, so file exchange needs no setup. The `drop` adapter implements the same `StorageAdapter` interface; the service is a 4thTech Cloudflare Worker (`apps/drop`) in front of an R2 bucket, served from its own host (beta: `drop.agentlink.4thtech.io`, D-28). Security rules are in 04 §4.

| Endpoint | Request | Behaviour |
|---|---|---|
| `POST /v1/upload` | Signed by the agent's drop key (04 §2.1): `{v: 1, size, expiresAt (≤ 7 days), nonce, ts}` plus the signature and the drop key's public key | Verifies the signature, the nonce and timestamp window, the size cap, the weekly quota per drop key and the rate limits per drop key and per IP. Returns `{objectId (random 128-bit), uploadUrl, expiresAt}`: `uploadUrl` is a short-lived (minutes), single-use signed PUT target that accepts exactly `size` bytes |
| `PUT <uploadUrl>` | Ciphertext bytes (ALF1) | Stores the object, hashing it as it streams; rejects a different length, an expired target or a second PUT. Files above 64 MB get one signed target per part (multipart), under the same limits |
| `POST /v1/o/{objectId}/commit` | Signed by the same drop key: `{v: 1, objectId, ciphertextSha256, nonce, ts}` | Completes the upload: compares `ciphertextSha256` with the hash computed while storing. On a match the object becomes readable and the Worker returns `{getUrl, expiresAt}`, a signed GET valid until `expiresAt`; on a mismatch it deletes the object |
| `GET <getUrl>` | — | Serves the ciphertext as `application/octet-stream`, `Content-Disposition: attachment`, `nosniff`, a sandboxing CSP and CORS for browser recipients (08 §7); refuses after `expiresAt` or above the per-object download limit |
| `DELETE /v1/o/{objectId}` | Signed by the uploading drop key (same format, method `DELETE`) | Deletes the object when retention triggers (`files.deleteAfter`, 04 §4). Only the uploading drop key can delete |
| `POST /v1/report` | Object URL, reason | Abuse report path: deletes only that object; blocking a drop key needs human review (04 §4). Never accepts file keys, envelopes or plaintext |
| `GET /v1/health` | — | Liveness only; aggregate counters stay internal |

- **Signature format.** Proposed: a NIP-98-style HTTP-auth event (kind 27235) in the `Authorization` header, signed with the drop key (BIP-340) through the `KeyStore`, with the method, URL and the SHA-256 of the request body as tags; the alternative is an EIP-712 struct signed with the drop key that includes the host. Either way it is domain-separated from envelopes, records and receipts, and the drop key is never the agent's Nostr or EVM identity key. Signatures travel in a header or the body, not in the URL path or query. The drop card fixes the format with test vectors in all three runtimes.
- **Mapping to the interface.** `put` = `POST /v1/upload`, `PUT` of the ciphertext, then the signed commit. The file is encrypted exactly once, with one file key and one nonce prefix; the core hashes the ciphertext as it streams it (hash as you go) and sends `ciphertextSha256` in the commit. If a hash is ever needed before the upload, the core encrypts once to a private temporary file and uploads exactly those bytes. It never re-encrypts with the same file key and nonce prefix; a retry re-sends the same bytes or encrypts afresh with a new file key and nonce prefix. Threat note: if the file changed between two encryption passes, the same key and nonces would encrypt different plaintext (AES-GCM nonce reuse). `presignGet` returns the `getUrl` from the commit; the object expires at the requested `expiresAt` (at most 7 days after upload), and a `refresh-link` answer cannot extend it. `delete` = signed `DELETE`.
- **Expiry.** Hard 7 days from upload, enforced by the Worker on every GET and by an R2 lifecycle rule as the backstop.
- **Limits.** Proposed 100 MB per file and 1 GB per drop key per week; the Worker returns a typed `limit` error that the core maps to `needs_setup` (06 §2.3). Per-IP rate limits (IPv6 per /64) and a global cap back the per-key quota; many drop keys from one source are the residual sybil risk (04 §4).
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

1. File ≤ 12 KB → `inline` (§5.3).
2. `files.storage: own` → own storage; if none is configured → `needs_setup`. Never the drop.
3. `files.storage: auto` (default) and own storage configured → own storage. No silent fallback to the drop if own storage fails.
4. `auto` or `drop`, within the drop limits (size cap, weekly quota) → `drop`.
5. Otherwise → `needs_setup`, naming the limit and the own-storage option.

Own storage means the S3-compatible adapter, or a consumer connector from M2. `agentlink_status` reports the result as `storage.mode` (06 §2.1).

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
  feeTokens: { symbol: "NATIVE" | "USDC" | "USDT"; address: Address | null; decimals: number; eip3009?: boolean }[];
  explorer: string;
  confirmations: number;
  testnet: boolean;
};
```

At launch `feeTokens` lists only USD stablecoins (D-46, 12 §3): USDC, USDT where available, and on Gnosis the native xDAI (`symbol: "NATIVE"`, `address: null`). A volatile native coin is never a fee token at launch (`NATIVE` on other chains is used only for gas in direct mode).

Users can override RPC URLs (privacy, reliability). No API keys baked into the client.

The **supported-chain list** (all `ChainConfig` entries, including contract and token addresses) **ships with each client release** (D-40). It is never fetched at runtime from a 4thTech service, so a compromised server cannot redirect payments. New chains arrive with a release; overrides live under Advanced.

### 6.2 Responsibilities

- Build and EIP-712-sign `Record` / `Receipt` / `AgentCard` (hash parity with Solidity via shared test vectors).
- Quote fees (`OCCFeeVault.quote`) and show them in USD, with the protocol and integrator parts separate (12 §5). Every launch fee token is a USD stablecoin valued 1:1, so **no price endpoint is needed**. (Later, with native volatile coins, 12 §3.4: a USD price source with an "≈" display, never used on-chain.)
- Choose chain and payment automatically (§6.3).
- Submit via submitter(s) with failover; fall back to direct mode if the agent has native gas.
- Watch for inclusion; update `proofs`/`receipts`.
- `verifyProofPack`: read `getRecord`, recompute hashes and commitment, check signatures, optionally decrypt with disclosed key and compare `envelopeHash`.

### 6.3 Chain auto-detection and selection (D-40)

There is no chain choice in the default UX (02 F-51).

1. **Detect.** For the agent address, query `OCCFeeVault.creditsOf` (per fee token) and the allowlisted stablecoin balances (`balanceOf`) on every supported chain, in parallel through the configured public RPCs, with a short time budget and a short cache (e.g. 60 s). Native gas balance is also read for direct mode. A chain that does not answer in time is skipped for this attempt.
2. **Select** for each paid action:
   1. the **default chain** (policy `proofs.defaultChain`) if it is funded;
   2. otherwise the **cheapest funded** chain, by the USD fee quote for this action;
   3. otherwise `needs_credits`, with a top-up suggestion (agent address, amount in $) on the **cheapest supported chain**.

   "Funded" means credits covering the quote, or a stablecoin balance that can become credits through the gasless top-up (F-46, once available).
3. **Override.** The tools' `chain?` input (06 §2.4) and the Advanced settings can force a chain; nothing else in the UX names one.
4. **Record.** The chosen chain is stored with the proof and written into the proof pack (`chainId`, §8), so verification needs no setup.

Querying every chain reveals the (pseudonymous, already public) agent address to those RPC providers; users who mind can set their own RPCs.

---

## 7. Submitter (4thTech service, open source)

Cloudflare Worker; stateless except rate-limit counters (Durable Object). It never sees plaintext and cannot alter what it submits.

| Endpoint | Body | Behaviour |
|---|---|---|
| `POST /v1/notarize` | `{chainId, records: [{record, signature}]}` | Validate signature and credits via `eth_call` simulation; submit (batched when possible); return tx hash and record IDs |
| `POST /v1/receipt` | `{chainId, receipts: [{receipt, signature}]}` | Same for receipts |
| `POST /v1/deposit-authorization` | `{chainId, token, auth: EIP-3009 fields}` | Check `value ≥ minDeposit` and token EIP-3009 support; submit `depositWithAuthorization` (vault calls `receiveWithAuthorization`) |
| `GET /v1/status/:txHash` | — | Inclusion status |
| `GET /v1/health` | — | Per-chain gas wallet balances, queue depth |

Requests and responses use the JSON form of 05 §3.1 (04 §2.4.1): `0x` + lowercase hex for addresses, `bytes32`, canonical ECDSA signatures and transaction hashes, and decimal strings for `uint256`.

- Gas wallets per chain (hot keys in Workers secrets, low balances, auto-alerts). Gas costs are recovered through protocol fees.
- Per-signer and per-IP rate limits; reject if simulated credits are insufficient.
- Anyone can run a submitter (same code); clients accept a list.
- No request logging beyond aggregate metrics; never log signatures linked to IPs.

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
  "signer": { "evm": "0x…", "agentCard": { /* optional, signed by owner; card JSON form, 04 §2.4 */ } },
  "envelopeHash": "0x…",
  "envelope": { /* optional ciphertext envelope */ },
  "recipient": { "evm": "0x…", "salt": "0x…" },          // optional disclosure
  "receipts": [ { "type": "DELIVERED", "signer": "0x…", "txHash": "0x…", "at": "…" } ],
  "disclosure": { "contentKey": "base64url" } | null,  // only if owner approved
  "ownerApproval": { "signed": { /* SignedOwnerAction, approval.decide */ }, "action": { /* commitment approval-request.action incl. context.scope */ } }
                 | { "standingRule": true, "policyHash": "<64 lowercase hex>" } | null,  // proof of agreement: included by default, owner may leave it out (04 §3.4, D-55)
  "exportedAt": "…"
}
```

Encodings follow 04 §2.4.1, and a verifier rejects a pack in any other form. `recordId`, `envelopeHash` and `recipient.salt` are `0x` + 64 lowercase hex. `recordId` and `salt` are the same strings as in the `proof` envelope body (04 §3.4), and `envelopeHash` the same as in a commitment scope (04 §3.4.2), so a value never has two spellings.

---

## 9. Node KeyStore backends (D-54)

`@agentlink/node` ships two backends behind the same core `KeyStore` interface (03 §3): the **OS keychain**, which is the default (04 §2.2), and the **passphrase-locked file KeyStore** for headless machines, which is opt-in (04 §2.8). Formats, KDF parameters, the owner-key rules, the threat model and the required tests are in 04 §2.8. This section covers runtime behaviour. Neither backend weakens `OwnerKeyStore` (04 §2.5).

### 9.1 Selection and the recorded backend

| Situation at `init` | Result |
|---|---|
| The OS keychain probe succeeds | Keychain. `--keystore file` is refused: "This machine has a system keychain. AgentLink uses it." There is no flag to force file mode (04 §2.8; proposed, owner confirms at merge) |
| The probe fails or times out | Treated as no usable keychain. The message also says how to fix the keychain, for example `security unlock-keychain` over SSH on macOS |
| No usable keychain, no opt-in | `needs_setup` (reason `no_keychain`); nothing is written |
| No usable keychain, `--keystore file` or "yes" to the question, in an interactive terminal with no harness marker set | File KeyStore at `~/.agentlink/keystore/<agentId>.alks`. Agent identity only; the owner step is separate (§9.3) |
| No usable keychain, opt-in without a TTY or with a harness marker set | `needs_setup` (reason `no_keychain`), naming the command the user runs in their own terminal. This is a UX guard; a faked terminal gets past it (04 §2.8) |

`init` records the backend in the agent's local config (`keyStore: "keychain" | "file"`). Every later start uses only the recorded backend: no fallback, no switch and no new identity when the other backend appears or the file is missing. Moving an agent between backends goes through `backup export` / `restore` (†, 06 §8, M1b); a dedicated move command is out of scope for now. The recorded value is not owner-signed. Changing it can only make the agent fail to start; it can never weaken the key protection.

### 9.2 Unlocking a file KeyStore

| Source | Where | Notes |
|---|---|---|
| `AGENTLINK_KEYSTORE_PASSPHRASE_FILE=<path>` | MCP server and CLI | Recommended. A secret mounted at run time (Docker or Kubernetes secret, tmpfs, host secret store), never inside the image, a committed `devcontainer.json` or the persisted home directory. Opened and checked per 04 §2.8 |
| `AGENTLINK_KEYSTORE_PASSPHRASE=<value>` | MCP server and CLI | Allowed for Codespaces and CI-style secrets, and weaker (04 §2.8; proposed, owner confirms at merge). `init` and the harness config writers never write it, and `doctor` always warns when it is set. Deleting it from `process.env` does not remove it from `/proc/<pid>/environ`, the parent processes, `docker inspect` or config files |
| Interactive prompt (no echo) | CLI in a terminal only | Never on the MCP stdio channel. No CLI argument takes the passphrase |

- **Order.** The file source is tried before the environment variable. If both are set, the server uses the file and `doctor` warns. The server deletes both variables from `process.env` after reading.
- **Harness config.** The harness passes the path to the MCP server in its MCP config, for example `claude mcp add agentlink -e AGENTLINK_KEYSTORE_PASSPHRASE_FILE=/run/secrets/agentlink -- npx -y @4thtech/agentlink mcp`. The path is not a secret.
- **Async unlock.** The server answers MCP `initialize` first and then runs the KDF asynchronously. Until the unlock finishes, tools return `needs_setup` (reason `keystore_locked`, "unlocking").
- **No working source.** Every tool returns `needs_setup` (reason `keystore_locked`), and no other tool runs.
- **Owner passphrase.** No source exists for it. `OwnerKeyStore` reads the owner code only from an interactive prompt or uses a passkey (04 §2.5, §2.8). `AGENTLINK_OWNER_*` variables are ignored, and `doctor` warns if one is set.

### 9.3 CLI surface

```
agentlink init --keystore file             # opt-in; interactive terminal only; agent identity only (06 §7)
agentlink owner init                     † # owner key on a file-KeyStore machine: generated owner code; run it yourself (04 §2.8)
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
| Changing the unlock code | "Changing the unlock code doesn't protect copies of the file made earlier (backups, image layers, snapshots). If the code or the file leaked, replace the agent." |
| `needs_setup` `keystore_locked` (agent relays it) | "AgentLink can't unlock your agent's identity on this machine. Set AGENTLINK_KEYSTORE_PASSPHRASE_FILE to the file that holds your unlock code, then restart your AI app." While unlocking: "AgentLink is starting up. Try again in a few seconds." |
| `doctor`, file backend | "Agent identity: passphrase-locked file (no system keychain). Unlocked from: secret file." |
| `doctor` warnings | "Unlocked from an environment variable, which leaks more easily than a secret file." · "The unlock code is stored on the same disk as the file, so a copy of this disk is not protected." (shown when the passphrase file is on the same filesystem as the keystore and not on tmpfs) · "Your owner key is on this machine. Approving from your own device is safer." · "AGENTLINK_OWNER_PASSPHRASE is set and ignored: approvals always ask in your terminal." |
| Approval needed on a headless machine (M1a) | "Approval needed. In your own terminal, run `agentlink approve {approvalId}`. Your AI can't approve for you." |
