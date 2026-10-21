# M1-9i design proposal: own storage and the recovery kit

> **Status: decided (D-115).** The owner accepted all five recommendations (A1, B1, C1, D1, E1) on 2026-10-21, in chat: "M1-9i: accept all 5 recommendations A–E." The review revisions of IR-DESIGN-M1-9i-1 are included. Nothing here changes a spec yet: card M1-9i-s applies the agreed text to 04, 06 and 07, and the build cards follow (backlog, M1-9i-s to M1-9i-d).
> Card: M1-9i ("CLI: owner commands for storage and backup"), stopped because 04 §2.3, §2.5.1, §2.8 and 06 §8 leave four things open.
> Inputs read: 04 §1 (I-4, I-7, I-10), §2.2, §2.3, §2.3.2, §2.5, §2.5.1, §2.8; 06 §8; 07 §3, §3.4, §5.2, §5.6, §9; D-48, D-49, D-78, D-82; `packages/types/src/{constants,owner-action}.ts`, `packages/core/src/{owner-action,owner-actions,policy-engine}.ts`, `packages/crypto/src/keystore-api.ts`, `packages/storage/src/{s3,session,endpoint}.ts`.

## 0. Summary

| # | Open point | Recommendation |
|---|---|---|
| 1 | Owner-signed ops | Three new ops: `storage.set`, `storage.remove`, `backup.export`. All `L(op)` = 600 s. Restore signs no `SignedOwnerAction`: its authority is the recovery code, as `owner init`'s is the new owner code |
| 2 | Kit format | One sealed file, magic `ALKK` v1: Argon2id + HKDF from a fresh generated recovery code, payload in the 04 §4 STREAM construction. Holds the owner seed, each agent's KeyStore items and its store snapshot |
| 3 | Own-storage config | Non-secret config only inside the signed `storage.set`, kept in a new store table `own_storage`; credentials in the KeyStore item `s3:<id>`, bound to the signed object by a salted digest. Never `config.json` |
| 4 | Restore | New import surface in the KeyStore backends; never overwrites anything; the owner seed is re-wrapped under a new generated owner code, the agent under the target machine's backend |

## 1. Owner-signed ops

### 1.1 Recommendation

| `op` | `params` (strict) | `L(op)` | Produced by | Rules |
|---|---|---|---|---|
| `storage.set` | `{id, provider, endpoint, bucket, region, credentialDigest}` | 600 s | CLI `agentlink storage connect` †; local UI (M1-11) | `id`: 8 CSPRNG bytes as 16 lowercase hex, new on every connect. `provider`: one of `r2`, `s3`, `b2`, `hetzner`, `scaleway`, `wasabi`, `minio`, `other` (display and help links only; no behaviour depends on it). `endpoint`: the exact output of `validateEndpoint` (`https://host[:port]`, 04 §4 grammar, no trailing slash). `bucket`: 3 to 63 of `[a-z0-9.-]` (S3 bucket rule). `region`: 1 to 32 of `[a-z0-9-]`, `auto` for R2. `credentialDigest`: 64 lowercase hex, §3.2. Applied only after the credential item exists and its digest matches. Replaces any earlier `storage.set` (one own storage per agent in M1). Not carried by any envelope |
| `storage.remove` | `{id}` | 600 s | CLI `agentlink storage disconnect` † (new); local UI | Applied only when `id` is the active `storage.set`. After the commit the CLI deletes the item `s3:<id>`. Objects already uploaded stay until their links expire; the copy says so |
| `backup.export` | `{kitId, contents}` | 600 s | CLI `agentlink backup export` † | `kitId`: 16 CSPRNG bytes, base64url without padding, also written into the kit manifest (§2.4), so the audit row names the kit. `contents`: `"full"` or `"identity"` (§2.3, OWNER DECISION A). One action per included agent, all signed in the one owner operation the export screen confirms (04 §2.5 "the signatures that the one owner flow confirmed"). The core applies it (nonce row = audit record, 07 §3.4) and only then does the CLI ask the export control to seal (§2.6). Not carried by any envelope |

- **Constants.** `OWNER_ACTION_OPS` gains the three ops; `OWNER_ACTION_MAX_LIFETIME_SECONDS` gains each at 600, which equals `LATER_OP_DEFAULT_LIFETIME_SECONDS`. `STORAGE_PROVIDERS` and `BACKUP_KIT_CONTENTS` are new frozen lists.
- **Why 600 s.** All three are signed and applied on the agent's own machine within seconds, like `contact.rename`. No console path exists for them in M1. When the console gets storage settings (M2), it needs its own decision, as `policy.set` did.
- **Why no `credentials` in params.** A signed object is stored in the store and may be shown in `doctor` or echoed later. Secrets go only to the KeyStore (I-7). The digest binds them.
- **Why no `storagePrefix`.** It already lives in `identity.storage_prefix` (07 §3) and is never chosen by the owner.

### 1.2 Restore is not a signed op (OWNER DECISION E)

**Recommended: E1, restore signs no `SignedOwnerAction`.** On a clean machine there is no card, no store and no nonce table to verify against before the restore has written them. Its presence proof is possession of the kit plus its recovery code, typed at an interactive prompt, as `owner init` creates an owner with no prior signature. After the restore, `doctor` shows the restored owner fingerprint and when it was restored.

- *E2 (alternative):* after writing, the restored owner signs a `backup.restore {kitId}` that the restored core applies as an audit row. It adds an owner-code entry and a code path but no security: whoever has the kit and the code can sign it.

### 1.3 Alternatives considered

- *One generic `keys.export` op for any export.* Rejected: params would need a union anyway; three narrow ops keep schemas strict and reviewable.
- *Storage config inside `policy.set` (`files.storage` beside it).* Rejected: credential rotation would bump the policy version, the policy is echoed to the console (04 §2.5.1), and 06 §3, its JSON form and the policy vectors would all change.

## 2. Recovery kit

### 2.1 What it is for

I-10 needs "export → restore on a clean machine restores identity, contacts and history". The 04 §2.3 step 6 kit (the `ALKR` blob) holds only the owner seed, which brings back none of that. A CLI kit therefore carries per agent: the agent seed, the other KeyStore items the store needs to open, and the store itself.

### 2.2 Recommendation: format `ALKK` v1

```
magic       "ALKK"              4 B
version     u8 = 1
secretKind  u8 = 1              generated recovery code; no other value is defined
kdf         u8 = 1              Argon2id v1.3 (RFC 9106)
m           u32be               memory in KiB
t           u8                  iterations
p           u8                  lanes
salt        16 B                random; new for every kit
aead        u8 = 2              AES-256-GCM STREAM, 04 §4 construction
chunkSize   u32be               1 MiB when written; 1..16 MiB accepted
noncePrefix 8 B                 random; new for every kit
ownerNostr  32 B                x-only owner Nostr key (public; lets restore check the owner before the KDF)
body        STREAM chunks
```

- **Key.** `kek = HKDF-SHA256(ikm = Argon2id(password(code, 1), salt, m, t, p, L = 32), salt = "", info = utf8("agentlink/v1/recovery-kit"), L = 32)`. Defaults m = 64 MiB, t = 3, p = 1; the `ALKS` floor and cap are checked before the KDF. A new salt per kit makes `kek` unique per kit, so the 8-byte nonce prefix plus chunk index never repeats under one key.
- **Body.** The 04 §4 STREAM: chunk `i` is AES-256-GCM under `kek` with nonce `noncePrefix ‖ u32be(i)` and AAD = `header (every byte magic … ownerNostr) ‖ u8(isFinal)`. Truncation, reordering, a changed header or a missing final chunk fail. Same chunk rules as `ALF1` (exact chunk sizes, no extra empty chunk). `aead` = 2 names this, so `ALKK` never shares an `aead` value with the single-shot formats.
- **Plaintext.** A list of entries `u16be nameLen | name (UTF-8) | u64be valueLen | value`, in this order; duplicates, unknown names, length overflow and trailing bytes are refused:
  1. `manifest`: JCS JSON `{"v":1,"kitId","createdAt","contents","ownerNostr","agents":[{"agentId","name"}]}` (agents sorted by `agentId`; `name` under the agent-name rule of 06 §6);
  2. `owner/seed`: 32 bytes;
  3. per agent, in manifest order: `agent/<agentId>/item/<name>` for each KeyStore item except `s3:*` (OWNER DECISION D), so `seed`, `store-key`, `policy-version`, `receipts-kept`; then `agent/<agentId>/store`: the store snapshot (§2.3).
- **Checks after decryption.** The owner seed must derive `ownerNostr` (header and manifest); each agent seed must derive its `agentId` (§2.9), and the snapshot's `identity.agent_id` must equal it; its stored card must name `ownerNostr`. Any failure: one generic error, everything wiped, nothing written.
- **Caps.** Each agent store snapshot ≤ 1 GiB (proposed), the whole kit ≤ 4 GiB; at most 16 agents; every non-store entry ≤ 64 KiB, as `ALKS`.
- **Secret entries never touch disk (IR-DESIGN-M1-9i-1 M1).** `manifest`, `owner/seed` and every `agent/<agentId>/item/<name>` stay only in `Uint8Array` memory buffers, wiped after use and on every failure; they are never written to a temporary file, never become JS strings, and never reach an error or log. Only the `agent/<agentId>/store` values may be streamed to a private temporary file (the 04 §4 quarantine rules, D-84: created exclusively without following links, mode 0600, stale ones removed at start-up). **Nothing is parsed or acted on before the final chunk authenticates:** the reader buffers secret entries and quarantines store bytes while decrypting, then, only after the final chunk's tag verifies, parses the entry list, runs the checks below and lets restore write anything. Any failure wipes the buffers and deletes the temporary files.
- **Type separation.** `ALKK` refuses `ALKP`, `ALKR`, `ALKO`, `ALKS` and `ALF1` before the KDF, and each of those refuses `ALKK` (cross-type vectors).
- **Versioning.** As 04 "Both formats": readers refuse any `version` ≠ 1 before the KDF; v2 needs a spec change, a decision and new vectors. Writers write v1 only. The manifest's `v` is part of v1, not a second version axis.
- **Primitives.** All through `@4thtech-io/crypto` (Argon2id and HKDF from `@noble/hashes`, AES-GCM through the existing STREAM code of M1-1d). Callers never call a primitive (AGENTS.md, I-8).

### 2.3 Kit contents: with or without history (OWNER DECISION A)

**Recommended: A1, `full` by default, `--identity-only` as an option.** I-10 and the card's acceptance say "identity, contacts and history". The store keeps only message payloads (≤ ~17 KB each) and metadata; file contents are not in it (they are files in the inbox folder, backed up like any file). A typical store is a few MB.

- *Snapshot (IR-DESIGN-M1-9i-1 M2).* Under one hold of the agent's inter-process lock (06 §6), the same lock that guards raising `policy-version` and writing `receipts-kept` (04 §2.2): read the KeyStore items `policy-version` and `receipts-kept`, then `VACUUM INTO` a private temporary file, then release the lock. The marks and the store in the kit are therefore one consistent cut, so a restored policy loads at its mark instead of failing closed with `mark_mismatch`. Its `enc` columns stay sealed under the store key, which travels with it.
- *`identity` mode.* The same snapshot with message, file, outbox, idempotency and held-envelope rows deleted before sealing (tables named in M1-9i-a against 07 §3). Contacts, pairings, policies, the policy and receipts marks, approvals, nonces, the budget ledger and revocations stay, because the restored agent needs them to keep working.
- *Privacy trade-off.* A `full` kit plus its code opens all history. The kit is as sensitive as the machine itself; the export copy says so and suggests storing kit and code apart.
- *Clear header links the kit to its owner (IR-DESIGN-M1-9i-1 L3).* `ownerNostr` is in the clear header, so anyone who finds a kit file can tell whose it is (the owner key is shared with every contact through the card). It reveals nothing else. The gain is that restore can show the owner fingerprint and refuse a different owner before the KDF. Alternative: move it into the encrypted manifest only; restore then checks the owner after the code is typed.
- *A2 (alternative):* identity and contacts only, history never in the kit. Smaller and lower-impact if leaked, but I-10 and the acceptance test then fail for history; history would need a separate export later.

### 2.4 One code per kit (OWNER DECISION B)

**Recommended: B1, a fresh generated 120-bit recovery code for every export**, shown once under the `owner init` display rules (re-type the last group, screen cleared, never written to a file, never in output or logs). A stolen old kit plus its code never opens a newer kit, and there is nothing to verify the code against before sealing.

- *B2 (alternative):* the owner types one long-lived recovery code at every export. Easier to keep, but the CLI cannot check it (nothing local is sealed under it), so a typo produces a kit nobody can open; it would need a typed-twice rule.
- **Relation to `ALKR`.** The console kit (04 §2.3 step 6) stays `ALKR`: the browser has only the owner. The CLI kit is `ALKK` and does not embed an `ALKR` blob (it would be a second wrap of the same seed under the same code). `init`'s recovery-kit offer (M1-9h) runs `backup export --identity-only` right after owner setup.

### 2.5 Storage credentials in the kit (OWNER DECISION D)

**Recommended: D1, not in the kit.** After a restore, own storage reads "configured, credentials missing" (§3.3), which never falls back to the drop, and `doctor` names `agentlink storage connect`. This matches D-49 for OAuth tokens ("not part of the recovery kit"), keeps cloud credentials out of a file people copy around, and the user can rotate the key at the provider. *D2:* include `s3:*` items, so own storage works right after a restore.

### 2.6 Export: who sees the seeds

No caller ever holds a raw seed. A new **`KeyExportControl`** in `keystore-api.ts`, modelled on `KeyEpochControl`: a distinct object, built only by owner flows, paired with the `OwnerKeyStore`, accepting only a session that store minted (checked by identity). Its one method `sealRecoveryKit(session, {kitId, contents, agents, snapshots})` reads the owner seed and the agent items inside the backend, writes the `ALKK` stream to a path the CLI gives (created `O_CREAT | O_EXCL | O_NOFOLLOW`, mode 0600, refused under `~/.agentlink`), and returns the recovery code bytes for display only. The agent `KeyStore` gains no method. Every seed and the code are wiped after use (04 §8 rule 3).

## 3. Own-storage config and credentials

### 3.1 Where things live (recommendation)

| What | Where | Why |
|---|---|---|
| endpoint, bucket, region, provider, `id` | Only in the signed `storage.set`, kept verbatim in a new store table `own_storage` (07 §3.4 style): `id` (`id`, clear), `signed_json` (`enc`: the endpoint and bucket identify the user's account), `applied_at` (`int`). At most one row in M1. Anti-rollback: the agent KeyStore item `storage-mark` (§3.3) | Signed and re-verified on load like the policy, so a store or file edit cannot redirect uploads (I-4) |
| access key ID, secret access key | KeyStore item `s3:<id>`: keychain account `<agentId>:s3:<id>`, or the `ALKS` entry `s3:<id>` (04 §2.2, §2.8; no format change). Value: JCS JSON `{"v":1,"salt","accessKeyId","secretAccessKey"}`, UTF-8 bytes, kept as `Uint8Array`; `salt` 16 CSPRNG bytes base64url | Keychain is where every agent secret lives (07 §5.2) |
| `config.json` | Nothing | Unsigned (07 §9.1): it may only make the agent fail to open |
| Temporary credentials (`sessionToken`) | Refused in M1 | They expire within hours; the agent cannot refresh them |

`<id>` gets the fixed format the 04 §2.2 note asks for: 16 lowercase hex.

### 3.2 Binding credentials to the signed object

`credentialDigest = HMAC-SHA256(key = salt, msg = JCS({"accessKeyId", "secretAccessKey"}))` as 64 lowercase hex, through `@4thtech-io/crypto`. The salt keeps a weak MinIO secret from being guessable from the stored object; the signature stops a same-user script that does not modify the package from swapping in other credentials or another bucket (it cannot produce a matching signed object). G-1 residual unchanged.

### 3.3 How the core and the policy engine learn about it

A new core read, `ownStorage.load()`, returns one of:

- `none`: no row, and the `storage-mark` names no active `id`;
- `ready {config, credentials provider}`: the row's `storage.set` verifies (`sig`, `agent`, `owner`, schema), the item `s3:<id>` exists and its digest matches;
- `broken {reason}`: a row exists but does not verify, the item is missing or does not match, or the row and the `storage-mark` disagree.

**Anti-rollback (IR-DESIGN-M1-9i-1 L2).** An old signed `storage.set` row plus its old credential item, put back after a `storage.remove` or a newer connect, would still verify. So the agent KeyStore item `storage-mark` (keychain `<agentId>:storage-mark`, `ALKS` entry `storage-mark`), raised under the agent's inter-process lock after each apply and read back, holds JCS JSON `{"v":1,"seq","active"}`: `seq` the count of applied `storage.set` and `storage.remove` actions (canonical decimal as for `policy-version`), `active` the active `id` or `null`. Each apply increments `seq`. On load, the row's `id` must equal `active`; a row with `active` = `null`, or no row with `active` set, reads `broken`. A malformed mark fails closed (`broken`), never `none`. The mark travels in the kit with the other items, and is cleared to `active: null` on restore when credentials are not restored (D1). Residual as for `policy-version`: a same-user process can roll back both (G-1).

**Reload ignores expiry.** As for a stored `policy.set` (04 §2.5.1 "Stored objects are re-verified, not trusted"), freshness and nonce checks apply once, at apply. On every later load the row is re-verified for encoding, `sig`, `agent`, `owner` and schema only; the 600 s `L(op)` and `expiresAt` are not checked again, so a connect keeps working after 10 minutes.

The runtime (CLI and MCP server, `src/runtime`) builds `FilesPlatform.ownStorage` with `createS3Adapter` only for `ready`. `outgoing.ts` already passes `ownStorageConfigured: own !== undefined`; it must also be `true` for `broken`, with an adapter stub that refuses every call (`credentials_unavailable`), so `files.storage: auto` never falls back to the drop when own storage was configured (07 §5.6 step 3). `agentlink_status` `storage.mode` and `doctor` report `broken` with the fix, naming no endpoint, bucket or key. The credentials provider reads the item at each use; the values never become log fields (I-7, canary test).

### 3.4 `storage connect` flow (summary for the CLI card)

Interactive terminal, no harness marker. Provider picker → instructions → endpoint, bucket, region typed; access key ID and secret read with echo off, never from an argument, environment variable or pipe → `validateEndpoint` and the SSRF-safe fetch (an endpoint resolving to a private address is refused, so a LAN-only MinIO is not supported in M1) → test upload, download and delete of one random object under `agentlink/<storagePrefix>/` → lifecycle-rule offer (07 §5.2) → owner code once → in that one owner session: write `s3:<id>` (through a `StorageCredentialControl` paired with the `OwnerKeyStore`, like §2.6), sign and apply `storage.set`, read back with `ownStorage.load()` = `ready`, then delete the previous `s3:<old id>` item. A failure before the apply removes the new item; the old config stays active.

## 4. Restore rules

### 4.1 Command and order

`agentlink backup restore <file>` †: interactive terminal only, harness-marker guard, the recovery code only from the prompt (never an argument, environment variable, file or pipe), no MCP tool (I-4). Steps:

1. Parse the header; refuse before the KDF on any format error. Show the owner fingerprint from `ownerNostr`.
2. **Refusals before the code is asked** (§4.2).
3. Ask for the recovery code (three tries); open, check (§2.2), list the agents with names and agent fingerprints; the owner confirms (default No).
4. Choose the backend per 07 §9.1 on *this* machine (keychain if the probe succeeds, else the file KeyStore opt-in), so restore is also the way to move an agent between backends.
5. Write, per agent, through a new **`KeyImportControl`** in each backend: every item at once (keychain items, or a new `.alks` under a new generated unlock code shown once); the store snapshot to `~/.agentlink/agents/<name>/store.sqlite` (temp file, fsync, rename, mode 0600, agent-dir rules); then `config.json` last, so a crash leaves no half agent that opens.
6. Owner: if no owner item exists, write the owner seed as `ALKO` under a **new generated owner code** with the `owner-next` write, read-back and open protocol of `owner change-code` (04 §2.8), then show the code under the `owner init` display rules. The recovery code never becomes the owner code.
7. Read back: open each restored agent with its KeyStore and store; the store's policy must load at the restored mark. Wipe everything. Print the next steps: storage reconnect (D1), "stop the agent on the old machine".

### 4.2 When something already exists (OWNER DECISION C)

**Recommended: C1, never overwrite; refuse and explain.**

| Found on this machine | C1 behaviour |
|---|---|
| An agent with the same `agentId` | Refuse that agent. Nothing for it is written |
| An agent folder with the same name, different `agentId` | Refuse unless `--agent <newname>` renames it on restore |
| An owner item exists | Ask for the **existing owner code** at the prompt (three tries). If it opens the item to exactly `ownerNostr`, keep the item and its code, no re-wrap, and restore only the agents. Otherwise refuse and write nothing. A card naming `ownerNostr` is never enough on its own: cards are public, so a same-user process could plant one beside an owner item it controls (IR-DESIGN-M1-9i-1 L1) |
| An owner item exists and the owner does not have its code | Refuse; the copy explains that a lost code on a machine with an owner needs a clean OS user or a clean machine (C2 would cover this later) |
| No owner item | Write the owner seed under a new generated owner code (§4.1 step 6) |
| A different owner | Refuse; restore into a new OS user or a clean machine |

*C2 (alternative):* a `--replace` flag that, after the current owner code is typed, moves the existing agent folder, `.alks` and keychain items to `~/.agentlink/replaced-<timestamp>/` and restores over them. Useful when a machine is half broken, but it adds a destructive path an agent could talk a user into; build it later if needed.

### 4.3 What the restored agent does next

- It resumes from its snapshot: relay catch-up brings in what arrived since, within relay retention (07 §4). Pending approvals in the snapshot expire normally. Outbox rows resend; recipients drop duplicates (seen-set).
- **Two live copies.** If the old machine still runs, both act as the same agent (same keys, credits, policy). The restore copy says to stop the old agent; `doctor` cannot detect it. Revoking the old copy means revoking the identity. Accepted residual, documented.
- The store key is not rotated: whoever had the kit and its code already has the plaintext history.

## 5. Security properties

| Property | How it holds |
|---|---|
| No secret reaches 4thTech | Export and restore are local file operations; nothing is uploaded. `storage connect` talks only to the user's own endpoint. No seed, code, salt, store key or S3 credential goes to a relay, the drop or any 4thTech service (I-1, I-2, I-3; zero-access rule) |
| No secret in logs or output (I-7) | Recovery code, owner code and unlock code: one-time display only, never logged. S3 secret: read with echo off, never printed. Endpoint and bucket are not logged either (they are in `enc` columns). Canary test over logs (debug included), errors, `doctor`, crash traces, the store and every file except the kit and the `.alks` |
| Kit sealed only with a key from the recovery code, via `@4thtech-io/crypto` | §2.2: Argon2id + HKDF with a new label, STREAM AES-256-GCM, vectors generated independently in Python |
| No MCP tool can trigger any of it (I-4) | No tool, no tool schema field and no `nextStep` runs these commands. Each is †: interactive terminal, harness-marker guard, owner code at the prompt. Export needs an owner session (`KeyExportControl` checks it by identity); credentials are written only with one (`StorageCredentialControl`); restore writes only from the CLI. A test asserts the MCP registry has no tool whose handler reaches these controls (import fence) |
| Fail closed | Unknown version, magic, size, owner or agent mismatch: refused before writing. Broken own storage never falls back to the drop |
| G-1 | Unchanged: a modified package or a memory reader as the same OS user can capture the codes (04 §2.5). Restore and export add one more owner-code entry each |

## 6. Proposed spec text changes (diff-style; applied only by M1-9i-s after the decisions)

**04 §1, I-10** (no change of meaning): append "The CLI recovery kit is `ALKK` (§2.3.3)."

**04 §2.2, keychain item names**
- `- When storage credentials land (\`s3:<id>\`), \`<id>\` gets a fixed format.`
- `+ Storage credentials are the agent item \`s3:<id>\`, under \`<agentId>:s3:<id>\`, where \`<id>\` is 8 CSPRNG bytes as 16 lowercase hex, new at every connect (M1-9i). Its value is JCS JSON {v: 1, salt, accessKeyId, secretAccessKey} as UTF-8 bytes; see §2.5.1 \`storage.set\`.`

**04 §2.3 step 6**
- `- **Recovery kit:** downloadable file with the encrypted seed (the \`ALKR\` blob), the recovery code (to be printed or stored in a password manager) and instructions.`
- `+ **Recovery kit.** In the console: a downloadable file with the \`ALKR\` blob, the recovery code and instructions. On the agent machine: \`agentlink backup export\` † writes an \`ALKK\` kit (§2.3.3) holding the owner seed and, per agent, its KeyStore items and store, sealed under a new recovery code shown once.`

**04 new §2.3.3 "Recovery kit format `ALKK` v1"**: the text of §2.2 to §2.6 and §4 of this proposal (format, key, body, plaintext entries, checks, caps, contents modes, export control, restore order and refusals). Add `ALKK` and `ALF1` to "Type separation" in "Both formats".

**04 §2.5.1, lifetimes table**
- `- | any later op (storage credentials, key export, content-key disclosure) | 600 s …`
- `+ | \`storage.set\`, \`storage.remove\`, \`backup.export\` (M1-9i) | 600 s (10 min) | Signed and applied on the agent's own machine within seconds; no envelope carries them |`
- `+ | any later op (content-key disclosure) | 600 s …` (rest unchanged)

**04 §2.5.1, "Ops defined here"**: change the lead-in to "(others, such as content-key disclosure, …)" and add three rows from §1.1 of this proposal.

**04 §2.5, owner-only list**: "add storage credentials" → "add or remove own storage (`storage.set`, `storage.remove`)", "export keys" → "export keys (`backup.export`, recovery kit)"; add "Restore from a recovery kit signs no owner action; its authority is the kit and its code (§2.3.3)".

**04 §2.8 "`owner init` rules", "An existing owner is linked or restored"**: append "Restore follows §2.3.3: it never overwrites an owner item or agent; the owner seed is re-wrapped under a new generated owner code with the `owner-next` protocol, unless the same owner is already present."

**04 §2.8 "Required tests" canary list**: add the recovery code and the kit `kek`.

**06 §8**
- `- agentlink storage connect              † # optional: guided S3-compatible setup (creds → keychain); not needed for files within the drop limits`
- `+ agentlink storage connect              † # optional; interactive terminal only, no harness marker: guided S3-compatible setup; test upload, download and delete; credentials read with echo off into the KeyStore item s3:<id>; signs storage.set (04 §2.5.1)`
- `+ agentlink storage disconnect           † # signs storage.remove and deletes the credentials; files already sent stay until their links expire`
- `- agentlink backup export | restore <file>   †`
- `+ agentlink backup export [--identity-only] [--agent <name>] <path>   † # interactive terminal only, no harness marker: signs backup.export per agent and writes an ALKK kit (04 §2.3.3); shows a new recovery code once`
- `+ agentlink backup restore <file> [--agent <newname>]   † # interactive terminal only, no harness marker: recovery code at the prompt; never overwrites (04 §2.3.3); shows a new owner code once when it creates the owner`

**07 §3.4**: add the `own_storage` table (§3.1 of this proposal): columns, one row in M1, apply = nonce + upsert in one transaction, load = re-verify, "At rest: `signed_json` `enc`", "On failure: `broken`, never the drop".

**07 §5.2, credentials bullet**
- `- Credentials (access key ID + secret) stored in the OS keychain (local) or Worker secrets (cloud).`
- `+ Credentials (access key ID + secret) stored in the KeyStore item \`s3:<id>\` (04 §2.2; the OS keychain or the file KeyStore), bound to the owner-signed \`storage.set\` by \`credentialDigest\` (04 §2.5.1), or in Worker secrets (cloud). Temporary credentials are refused in M1. Not part of the recovery kit.`

**07 §5.6**: add "Own storage counts as configured when a `storage.set` row exists, also when it is `broken` (signature, credentials missing or mismatched); a broken own storage makes the tool return `needs_setup` (core refusal `needs_storage`) naming `agentlink storage connect`, never the drop."

**07 §9.1**: "Moving an agent between backends goes through `backup export` / `restore`" → append "(04 §2.3.3, step 4: restore uses the backend this machine selects)".

**07 §9.4**: copy rows for export (code shown once, kit as sensitive as the machine), restore (owner fingerprint, "stop the old agent") and storage connect (no "credentials" jargon beyond "access key").

## 7. Backlog split

Order follows D-82: spec → vectors → implementation.

| Card | Tier, class | Owns (disjoint) | Depends on |
|---|---|---|---|
| **M1-9i-s** spec text | Opus, S1 (new crypto format text) | `docs/foundation/04-*.md`, `06-*.md`, `07-*.md`, `00-README.md` (decision row) | owner decisions A to E |
| **M1-9i-a** types and core ops | Opus, S2 | `packages/types/src/{constants,owner-action}.ts` and tests; `packages/core/src/{owner-action,owner-actions}.ts`, new `packages/core/src/own-storage.ts`, the store migration and `Store` contract for `own_storage`; `packages/core/src/files/outgoing.ts` (`broken` counts as configured); owner-action vectors for the three ops; the `storage-mark` read and raise | M1-9i-s, M1-9i-b (`credentialDigest`) |
| **M1-9i-b** crypto kit format and vectors | Opus, S2 | `packages/crypto/src/recovery-kit.ts` (new), `KeyExportControl`, `KeyImportControl`, `StorageCredentialControl` types in `keystore-api.ts`, `credentialDigest`; `test-vectors/recovery-kit/`, `tools/vectors/generate_recovery_kit.py` (independent of the TypeScript) | M1-9i-s |
| **M1-9i-c** node backends: export, import, credential items | Opus, S2 | `packages/node/src/**` (keychain and file backends implement the three controls; `s3:<id>` items; restore's owner `ALKO` write via `owner-next`) | M1-9i-b |
| **M1-9i** (existing, narrowed) CLI commands | Opus, S2 | `apps/cli/src/**`: `storage connect | disconnect`, `backup export | restore`, runtime wiring of `ownStorage.load()`, `doctor` lines, strings; `init`'s kit offer (from M1-9h) | M1-9i-a, M1-9i-c, M1-6b |
| **M1-9i-d** docs | Sonnet, S0 | README Status, `docs/status.yaml` and generated blocks, quickstart and a restore runbook in `docs/runbooks/`, `changelog.d/` | M1-9i |

After the spec: M1-9i-b first (it exports `credentialDigest`), then M1-9i-a and M1-9i-c in parallel. Every S2 card: tests first with a `RED (expected):` commit, independent Opus audit, Tali's "merge".

## 8. Owner decisions

**Accepted (D-115).** Tali, in chat, 2026-10-21: "M1-9i: accept all 5 recommendations A–E." Every point below is decided as its recommended option; the alternatives are kept for the record.

| ID | Question | Decided (recommended) | Alternative (not chosen) |
|---|---|---|---|
| A | Kit contents | **A1:** full history by default, `--identity-only` option | A2: identity and contacts only, never history |
| B | Recovery code | **B1:** a fresh code per kit, shown once | B2: one long-lived code typed at each export |
| C | Restore when something exists | **C1:** never overwrite; refuse per §4.2; same owner is reused | C2: `--replace` that moves the old setup aside after the old owner code |
| D | Storage credentials in the kit | **D1:** no; reconnect after restore | D2: include `s3:*` items |
| E | Restore as a signed op | **E1:** no signed op; the kit and code are the authority | E2: sign `backup.restore` as an audit row |
