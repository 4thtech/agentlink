# 07 — SDK, Transport and Storage

All packages live in the public `agentlink` monorepo (see 09). Every package must run in **Node (LTS)**, **modern browsers** and **Cloudflare Workers** unless marked otherwise. No Node-only APIs in shared packages (use `globalThis.crypto`, `fetch`, `Uint8Array`).

---

## 1. Package map

| Package | Depends on | Exposes |
|---|---|---|
| `@agentlink/types` | — | Shared types, zod schemas, constants (kinds, receipt types, fee types) |
| `@agentlink/crypto` | noble, hpke | Key derivation, HPKE seal/open, AES-GCM, STREAM file encryption, hashing, JCS, BIP-340 sign/verify, EIP-712 helpers |
| `@agentlink/chain` | viem, types, crypto | Chain configs, contract ABIs, fee quotes, credits, record/receipt building, submitter client, proof verification |
| `@agentlink/transport-nostr` | nostr-tools, crypto | `Transport` implementation: relay pool, gift wrap/unwrap, subscriptions, sync cursors |
| `@agentlink/storage` | crypto | `StorageAdapter` interface; `inline`, `s3` adapters (P0); `ipfs-pinning` (P2) |
| `@agentlink/core` | all above | `AgentLinkClient`: identity, contacts, envelopes, threads, files, proofs, policies, approvals; `KeyStore`, `Store`, `ApprovalChannel` interfaces |
| `@agentlink/node` | core | Node implementations: keychain `KeyStore`, SQLite `Store`, local approval server (Node only) |
| `@4thtech/agentlink` | node, core | CLI + MCP server (stdio) (Node only) |

Integrators use `@agentlink/core` directly (with their own `KeyStore`/`Store`) and pass their `appId` to earn integrator fees.

---

## 2. Core API (sketch)

```ts
const client = await AgentLinkClient.create({
  keyStore, store, approvals,
  transport: new NostrTransport({ relays }),
  storage: storageAdapterFromConfig(cfg),       // inline + optional s3
  chains: defaultChains({ enabled: ["base", "gnosis"] }),
  submitters: ["https://submit.agentlink.example"], // optional; direct mode always available
  appId: ZERO_APP_ID,
});

await client.createInvite({ label, expiresInDays });
await client.acceptInvite(url);
await client.sendMessage({ to, text, type, body, replyTo, notarize });
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

---

## 3. Local store schema (SQLite; Durable Object uses the same schema)

| Table | Key columns |
|---|---|
| `identity` | agent_id, agent_card_json, key_epoch, created_at |
| `contacts` | contact_id, name, agent_card_json, owner_fingerprint, verified, status (active/blocked), created_at |
| `invites` | invite_id, secret_hash, label, expires_at, used_at |
| `envelopes` | envelope_id, thread_id, direction, contact_id, type, created_at, envelope_json (ciphertext), payload_json (decrypted, optional per setting), read_at |
| `files` | envelope_id, idx, name, size, sha256, locator, url, file_key (encrypted at rest with a keychain-held local key), expires_at, deleted_at |
| `proofs` | envelope_id, chain_id, record_id, tx_hash, status, fee_token, fee_amount, salt, created_at |
| `receipts` | record_id, type, signer, tx_hash, at |
| `approvals` | approval_id, action_json, summary, status, created_at, decided_at |
| `policies` | key, value_json, updated_at |
| `sync_cursors` | relay_url, last_seen |

**At rest:** all sensitive columns (decrypted payloads, contact names, file names, URLs, file keys, salts, policies' parameters) are encrypted with a local **store key** (random, kept in the keychain). Non-sensitive columns (IDs, timestamps, statuses) stay in clear for indexing. Without the store key, the database reveals only activity timing and counts.

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
- **Relays:** each agent card lists 3–5 relays (default: a curated set of reliable public relays + the optional 4thTech relay). Publish to the **recipient's** relays and the sender's own relays.
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
  kind: "inline" | "s3" | "ipfs";
  put(ciphertext: ReadableStream | Uint8Array, opts: { size: number; expiresAt: Date }): Promise<StoredObject>;
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

### 5.4 Later adapters

- `ipfs-pinning`: Pinata / Filebase / Storacha (P2).
- Filecoin Onchain Cloud or a future PollinationX v3 adapter (post-beta).
- D-13 (open): optional 4thTech temporary encrypted drop (R2, ciphertext only, 7-day expiry, size-capped) for users without storage.

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
| `POST /v1/notarize` | `{chainId, records: [{record, sig}]}` | Validate signature and credits via `eth_call` simulation; submit (batched when possible); return tx hash and record IDs |
| `POST /v1/receipt` | `{chainId, receipts: [{receipt, sig}]}` | Same for receipts |
| `POST /v1/deposit-authorization` | `{chainId, token, auth: EIP-3009 fields}` | Check `value ≥ minDeposit` and token EIP-3009 support; submit `depositWithAuthorization` (vault calls `receiveWithAuthorization`) |
| `GET /v1/status/:txHash` | — | Inclusion status |
| `GET /v1/health` | — | Per-chain gas wallet balances, queue depth |

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
  "record": { /* Record struct fields */ },
  "signature": "0x…",
  "signer": { "evm": "0x…", "agentCard": { /* optional, signed by owner */ } },
  "envelopeHash": "0x…",
  "envelope": { /* optional ciphertext envelope */ },
  "recipient": { "evm": "0x…", "salt": "0x…" },          // optional disclosure
  "receipts": [ { "type": "DELIVERED", "signer": "0x…", "txHash": "0x…", "at": "…" } ],
  "disclosure": { "contentKey": "base64url" } | null,  // only if owner approved
  "exportedAt": "…"
}
```
