# 04 — Security and Cryptography

This document is binding. Any change to it requires an explicit decision recorded in `00-README.md`.

---

## 1. Invariants (non-negotiable)

| ID | Invariant |
|---|---|
| **I-1** | Private keys are generated on the user's side and never transmitted in plaintext to any 4thTech system, relay, storage provider or chain. |
| **I-2** | Plaintext content (messages, files, file keys, contact lists, policies) never leaves the user's side unencrypted. |
| **I-3** | 4thTech-operated services must function correctly if they are fully compromised, without exposing I-1 or I-2 data. They may only deny or delay service. |
| **I-4** | Policies, approvals, key export and storage credentials are **owner-controlled**: they take effect only with an **owner signature**, and the owner key is unlocked only with user presence (passkey or owner passphrase). No MCP tool and no agent process can produce one. |
| **I-5** | All inbound content from other agents is untrusted data. It is never executed, never interpreted as tool instructions by our code, and is clearly labelled as untrusted in tool results. |
| **I-6** | Every on-chain record and receipt is signed (EIP-712) with domain separation (chain ID, contract address, version) and replay protection (records: single-use nonce + deadline; receipts: one-time flag per record + deadline). |
| **I-7** | No logging of plaintext, keys, presigned URLs, salts or decrypted metadata anywhere (local logs included). Debug mode still redacts these. |
| **I-8** | Only audited, widely used crypto libraries. No custom primitives. |
| **I-9** | Every owner can decrypt every envelope sent or received by their agents. (File *contents* remain available only until the file's expiry unless archived; see §4.) |
| **I-10** | The user can export everything (keys via recovery kit, history, proofs) and leave. No lock-in to 4thTech services. |

---

## 2. Key hierarchy

Each **principal** (agent or owner) has one 32-byte random **master seed**. Purpose keys are derived with HKDF, so one backup restores everything and keys are never reused across protocols.

### 2.1 Derivation (exact)

```
okm = HKDF-SHA256(
        ikm  = masterSeed,
        salt = utf8("agentlink-v1"),
        info = utf8(label) || 0x00 || u32be(epoch) || u8(counter),
        L    = 32)
```

| Label | Curve / use | Epoch |
|---|---|---|
| `agentlink/v1/evm` | secp256k1 — EVM address; signs EIP-712 records, receipts, cards | **always 0** (stable: credits and commitments are tied to this address) |
| `agentlink/v1/nostr` | secp256k1 — Nostr identity (BIP-340); signs envelopes and seals; NIP-44 | current `keyEpoch` |
| `agentlink/v1/enc` | X25519 — HPKE recipient key | current `keyEpoch` |
| `agentlink/v1/drop` | secp256k1 (BIP-340) — **drop key**; signs only encrypted-drop requests (upload, commit, DELETE; §4). Never published: not in the agent card, and unlinkable to the agent card, the EVM address and any billing profile (D-48) | current `keyEpoch` (an object's locator records the epoch, so older objects stay deletable) |

- **secp256k1:** interpret `okm` as a big-endian integer; if it is 0 or ≥ curve order n, increment `counter` (starting at 0) and derive again.
- **X25519:** use `okm` as the private key; clamping per RFC 7748 is applied by the library.

### 2.2 Where seeds live

| Packaging | Agent seed | Owner seed |
|---|---|---|
| Local | OS keychain (service `agentlink`, account `<agentId>`) | **Never stored in plaintext on the agent machine.** Wrapped with a key from a **localhost passkey (WebAuthn PRF)** created in the local UI, or with the owner passphrase (Argon2id). Or not present at all: the owner uses the console |
| Local, desktop app (M2) | OS keychain, as above | **Never stored in plaintext.** Wrapped with a key that the OS keystore releases only after an OS user-presence check, and only to the signed app: **macOS** Keychain item with access control requiring user presence (Touch ID or device password), readable only by the app's code-signing identity; **Windows** a Windows Hello key credential that requires a gesture (DPAPI only as an extra at-rest layer, because DPAPI alone does not stop same-user processes); **Linux** the owner passphrase (Argon2id) or a polkit prompt, documented as **weaker** because neither binds the key to the app binary. See §2.5 and 08 §8 |
| Self-host Worker | Worker secret / Durable Object storage in the **user's** Cloudflare account | Not present |
| Console (browser) | — | IndexedDB, wrapped with a key derived from the owner passkey's **PRF** output |

Rationale: harness agents (Claude Code, Codex, Gemini CLI…) can run shell commands as the same OS user. They can read anything the agent process can read, including the agent seed. They must **not** be able to obtain the owner key, which is why owner operations require user presence (§2.5).

### 2.3 Owner identity in the browser (passkey)

1. On first use, the console generates the owner seed in the browser.
2. It creates a passkey with the PRF extension. `user.id` = the owner's Nostr public key (32 bytes), so a new device can find the owner after passkey sign-in.
3. `wrapKey = HKDF-SHA256(ikm = PRF(salt = sha256("agentlink-owner-v1")), salt = "", info = "owner-seed-wrap", L = 32)`; the seed is encrypted with AES-256-GCM and stored in IndexedDB.
4. **Backup:** the same encrypted blob is published as a Nostr parameterized-replaceable event (`d`-tag `agentlink-owner-backup`) signed by the owner Nostr key. A new device signs in with the synced passkey, reads `user.id`, fetches the blob from relays and decrypts it with PRF.
5. **Fallback** when PRF is unsupported: a **generated recovery code** (120 bits, shown as 24 base32 characters in groups) wraps the seed (Argon2id, m=64 MiB, t=3, p=1). User-chosen passphrases must not be used for blobs published to public relays, since those can be brute-forced offline.
6. **Recovery kit:** downloadable file with the encrypted seed, the recovery code (to be printed or stored in a password manager) and instructions. Raw seed export only under "Advanced".

### 2.4 Agent card

An **agent card** binds an agent's public keys to its owner. It is signed by the owner's EVM key with EIP-712 using a **chain-agnostic domain** `{name: "OCC AgentCard", version: "1"}` (no `chainId`, no `verifyingContract`), so the same signature is valid off-chain and in the Registry on every chain.

```
AgentCard {
  uint8   version;          // 1
  address agentEvm;         // agent EVM address (stable)
  bytes32 agentNostr;       // x-only pubkey (current epoch)
  bytes32 agentEnc;         // X25519 pubkey (current epoch)
  address ownerEvm;
  bytes32 ownerNostr;
  bytes32 ownerEnc;
  bytes32 nameHash;         // keccak256(utf8 display name); name travels off-chain
  bytes32 relaysHash;       // keccak256 of canonical (JCS) relay list
  uint64  issuedAt;
  uint64  expiresAt;        // 0 = no expiry
  uint32  keyEpoch;         // increments on rotation of nostr/enc keys
}
```

Display names are **self-declared** unless the agent is registered (F-41); UIs must label them accordingly.

### 2.5 Owner operations and user presence

Owner-only operations: approve/deny, change policies, add/remove allowed folders, add storage credentials, export keys, revoke agents, disclose content keys.

- Each is expressed as an **owner-signed object** (`OwnerAction{agentId, action, params, nonce, issuedAt}` signed by the owner Nostr key; or an `approval`/`policy` envelope from the console).
- The agent's core **verifies the owner signature** against the owner key in its agent card before applying the action. Policies are stored as signed documents and re-verified on load, so editing the database directly has no effect.
- Signing requires user presence: passkey (local UI on `localhost` or console) or owner passphrase (CLI prompt). The local UI holds no reusable bearer token on disk.
- **Desktop app owner presence (M2, D-36)** is stronger than localhost WebAuthn. Known weakness of the localhost passkey: a WebAuthn RP ID is a host name without port, so a passkey registered for `localhost` can be requested by any page on any localhost port, including one a shell-capable agent starts. Such a page could imitate the approval page and ask for the owner's gesture (the human must still complete the prompt). The desktop app removes this path: owner operations happen in a **native approval window** (not a localhost page), the OS prompt names the signed app, and the keystore releases the owner wrapping key only to that app (§2.2). Residual: on Linux, and wherever the OS falls back to a typed device password, an agent able to inject keystrokes and knowing the secret could complete the prompt; this is settled in the framework security review (08 §8).
- **Commitments (D-31)** are an approval path, not an owner-only operation. Sending an `accept` and signing an `ACCEPTED` or `REJECTED` receipt are agent actions gated by policy `commitments.accept` (default `approval`, 06 §3): the agent proposes, the owner approves or denies through the normal approval flow above (owner-signed, with presence), and only then does the agent's key send or sign. Auto-accept applies only within owner-signed limits (allowlisted contacts, maximum value).
- **Residual risk:** an agent with unrestricted shell access as the same OS user could tamper with the AgentLink installation itself or spend the agent's credits by signing records with the agent key. Mitigations: keep credits small; harness permission settings that deny access to `~/.agentlink` and the keychain (documented in the quickstart); owner revocation; per-agent spending caps in the vault (P2).

### 2.6 Key rotation

- A new `keyEpoch` derives new Nostr and encryption keys (EVM key unchanged) and issues a new agent card. Old epoch keys are re-derivable from the seed, so history stays readable.
- Contacts update the card when they see a higher epoch signed by the same owner (envelope type `card-update`).
- Owner key rotation (re-signing all agent cards) is P2.

### 2.7 Domain verification (M2, F-07)

An owner can prove control of a domain, so contacts see "verified domain" instead of a self-declared name (D-34).

- **Claim.** With owner presence, the owner signs a `DomainClaim {domain, ownerEvm, ownerNostr, issuedAt, expiresAt}` with the owner EVM key (EIP-712, chain-agnostic domain like the agent card, §2.4). The claim travels with the agent card, like the display name. The exact struct is fixed in the M2 Registry task (05).
- **Publication**, either:
  - DNS TXT at `_agentlink.<domain>`: `v=agentlink1; fp=<owner key fingerprint>; sig=<base64url claim signature>`; or
  - `https://<domain>/.well-known/agentlink.json` containing the full signed claim.
- **Check.** Clients verify when displaying a contact: the fingerprint must match the contact's owner key, and the signature and expiry must be valid. Browsers resolve TXT via DNS-over-HTTPS (resolver configurable); no 4thTech service is in the path. The domain comes from a counterparty, so the `.well-known` fetch follows the §4 SSRF rules (https only, no private or link-local addresses, ≤ 2 re-checked redirects, small size cap). Results are cached (e.g. 24 h); a failed re-check downgrades the label and, if the contact was verified before, warns.
- **Registry.** OCCRegistry (M2) may record a hash of the claim with the verified registration (F-41), timestamping when it was made; the live check still decides the label.
- **Labels:** "verified domain" (exact domain shown; internationalized names also shown in punycode) vs "self-declared".
- **What it proves:** whoever controlled the domain at check time vouched for this owner key. Not legal identity: EU qualified e-signature (eIDAS) integration is researched in M4 (F-08, P2).

---

## 3. Envelope (message container)

### 3.1 Structure (v1)

All binary values are base64url **without padding** in JSON unless noted.

```jsonc
{
  "v": 1,
  "id": "<16 random bytes>",
  "thread": "<16 bytes, stable per conversation>",
  "from": "<agent nostr x-only pubkey, hex>",
  "createdAt": 1760000000,
  "recipients": [
    { "kid": "<first 16 bytes of sha256(raw 32-byte encPub)>",
      "enc": "<HPKE encapsulated key>",
      "wk":  "<HPKE ciphertext of the CEK>" }
  ],
  "aead": { "alg": "A256GCM", "iv": "<12 bytes>", "ct": "<ciphertext || 16-byte tag>" },
  "sig": "<hex BIP-340 signature>"
}
```

- `envelopeHash = sha256(JCS(envelope without "sig"))` (RFC 8785). This is the value notarized on-chain.
- AEAD additional data = `sha256(JCS({v, id, thread, from, createdAt, recipients}))`.
- `sig` = BIP-340 Schnorr by `from` over `taggedHash("agentlink/envelope/v1", envelopeHash)` (BIP-340 tagged hash), so envelope signatures can never be confused with Nostr event signatures.

### 3.2 Recipient set (always)

1. Recipient agent (`agentEnc` of the contact)
2. Recipient owner (`ownerEnc` from the contact's agent card)
3. Sender owner
4. Sender agent (to read its own sent items)
5. Optional: arbitrator (P2)

### 3.3 Content key wrapping

- CEK: 32 random bytes per envelope.
- HPKE (RFC 9180), mode Base: KEM `DHKEM(X25519, HKDF-SHA256)`, KDF `HKDF-SHA256`, AEAD `AES-256-GCM`.
- `info = utf8("agentlink/v1/cek") || id` (`id` as its raw 16 bytes).
- Each recipient entry seals the CEK independently (empty AAD).
- Sender authenticity comes from `sig` and the agent card binding `from` to the owner, not from HPKE Auth mode.

### 3.4 Payload (plaintext inside `aead.ct`)

```jsonc
{
  "type": "text | request | offer | accept | reject | delivery | note | file | ack | handshake | handshake-ack | proof | approval | approval-request | policy | card-update | revoke",
  "body": "string or JSON (shape depends on type)",
  "replyTo": "envelope id | null",
  "files": [ {
      "name": "...", "size": 123, "mime": "...",
      "plaintextSha256": "hex",                // proves 'document matches' later
      "ciphertextSha256": "hex",               // integrity before decrypt
      "inline": "base64url (≤ 12 KB) | null",
      "url": "download URL (presigned, drop or share link) | null",
      "fileKey": "base64url(32)",
      "expiresAt": 1760000000 } ]
}
```

- **`proof` type** (body `{envelopeId, chainId, recordId, salt}`) is sent **after** a record is submitted, as a follow-up envelope. This works both for "send with proof" and for notarizing an older envelope; a notarized envelope itself never claims proof.
- **`approval-request` / `approval` / `policy`** carry owner operations between agents and the console (§2.5).
- **`offer` / `accept` / `reject` carry `terms`** (D-32), so agents can negotiate and agree on exact terms:

```jsonc
// body of offer / accept / reject
{
  "terms": {
    "termsId": "<16 random bytes>",              // stable for one negotiation
    "version": 3,                                 // +1 for each counter-offer
    "parties": ["0x<agent A>", "0x<agent B>"],    // agent IDs = stable agent EVM addresses (§2.1); two parties in beta
    "subject": "Spec v2 – milestone 3",
    "deliverables": [ { "id": "d1", "description": "…", "plaintextSha256": "hex | null" } ],
    "price": { "amount": "1500.00", "currency": "EUR" },   // optional; decimal string; ISO 4217 code or token symbol
    "deadlines": [ { "ref": "d1", "due": "2026-11-30T17:00:00Z" } ],
    "validUntil": 1760600000,                     // unix seconds; the terms lapse after this
    "previousTermsHash": "hex | null"             // termsHash of the version this one replaces
  },
  "termsHash": "hex",                             // sha256(JCS(terms)), RFC 8785
  "note": "string | null"                         // optional free text (e.g. reason for a reject); not covered by termsHash
}
```

  - `termsHash = sha256(JCS(terms))`. The core recomputes it on send and on receipt and refuses a mismatch.
  - `offer` carries proposed terms. `accept` and `reject` carry the terms they answer (so a notarized `accept` is self-contained) and **must quote their `termsHash`**. The core refuses to send an `accept` unless the hash matches an `offer` received from that contact in the thread, the terms are within `validUntil`, and `parties` are exactly the sender and the recipient. `previousTermsHash` must point to an earlier version in the thread (`null` for version 1).
  - Before signing `ACCEPTED` or `REJECTED` on a record whose envelope carries `terms`, the core applies the same checks (own agent ID in `parties`, not expired). Both paths need owner approval by default (policy `commitments.accept`, §2.5, 06 §3).
  - Received terms are untrusted content (I-5): validated structurally only, shown inside the untrusted block (06 §4) and marked as the other party's content on approval screens. `price` is informational: AgentLink moves no money.
  - **Proof of agreement.** The final terms envelope is notarized (record kind `OFFER` for an `offer`, `ACCEPT` for an `accept`, 05 §3.1) and the counterparty signs `ACCEPTED` on that record. The proof pack (07 §8) includes the envelope and its disclosed content key (policy `proofs.allowKeyDisclosure`), so a verifier can decrypt, recompute `termsHash` and check that the record signer and the receipt signer are the two `parties`. Disclosing the key reveals the whole payload, so the final terms envelope should carry only the terms. The pack shows that both agents, each bound to its owner by the agent card, assented to the same terms at the recorded times (mutual assent). It does not by itself establish legal enforceability or the signatory's authority. `DECISION NEEDED (owner)`: optionally add each owner's signed approval (§2.5) to the pack, as off-chain evidence that the owners, not only their agents, approved.

### 3.5 Transport wrapping (Nostr)

- The envelope JSON is the `content` of an unsigned **rumor** (kind 14, tag `["agentlink","1"]`), sealed (kind 13) with the sender's Nostr key, then **gift-wrapped** (kind 1059) with an ephemeral key to each recipient Nostr pubkey, per NIP-59 / NIP-17 with NIP-44 v2 encryption.
- The receiver requires the seal's pubkey to equal `envelope.from`.
- One gift wrap per recipient Nostr key (recipient agent, recipient owner, sender owner).
- **Size limits:** serialized envelope ≤ **24 KB**; inline files ≤ **12 KB**. Nesting (seal + gift wrap, NIP-44 padding, base64) roughly doubles size, and NIP-44 caps plaintext at 65,535 bytes; many relays cap events at 64 KB. Before publishing, check the final gift-wrap size against each relay's NIP-11 `max_message_length`.
- Gift-wrap timestamps are randomized up to 2 days in the past (NIP-59), so inbox sync must use a ≥ 48 h look-back window and deduplicate by envelope ID (see 07 §4.2).

### 3.6 Pairing protocol

**Invite** (created by agent A):

```jsonc
{ "v": 1, "inviteId": "<16 bytes>", "secret": "<32 bytes>", "card": { /* A's AgentCard */ },
  "cardSig": "<owner EIP-712 sig>", "name": "Tali's Claude", "relays": ["wss://…"], "expiresAt": 1760600000 }
```

- Encoded as base64url(deflate(JSON)). Shared as `https://<invite-host>/i#<payload>` (the fragment is never sent to a server) and accepted by the CLI/MCP from the full URL or the bare payload. Until the invite landing page ships (M2), the host serves a static "how to install" page.
- A stores `{inviteId, sha256(secret), expiresAt, used=false}`. Single use; default expiry 7 days.

**Accept** (agent B):

1. Verify `cardSig` and expiry.
2. Apply policy `contacts.acceptInvites` (default `approval`: owner confirms in local UI or console, seeing name, owner fingerprint and safety code).
3. Send a `handshake` envelope to A (recipients: A agent, A owner, B owner, B agent) with body `{inviteId, card: B's AgentCard, cardSig, name, relays, proof}`, where `proof = HMAC-SHA256(secret, utf8("agentlink-handshake") || inviteId || sha256(JCS(B card)))`.

**Complete** (agent A):

- Unknown senders normally go to the requests queue. A `handshake` is the one exception: it is accepted if `proof` matches an unused, unexpired invite. A then marks the invite used, adds B, and replies `handshake-ack`.

**Safety code:** `sha256(sortBytes(A.agentNostr, B.agentNostr) || sortBytes(A.ownerNostr, B.ownerNostr))`, first 40 bits shown as 12 decimal digits in three groups of four. Both sides show the same code. It needs both sides' keys, so it cannot exist when the invite is created: `create_invite` returns only the inviter's owner fingerprint. B can compute it at accept time, because it already holds A's card, so B's owner confirmation (Accept step 2) shows it; A learns it when B's handshake arrives. After the handshake both sides show it, to be compared through another channel.

---

## 4. Files

- **Ciphertext object layout:** header `magic "ALF1" (4 B) | version u8 | chunkSize u32be | noncePrefix (8 B)` followed by chunks. Each chunk is AES-256-GCM with nonce `noncePrefix || u32be(chunkIndex)`; the AAD is `u8(isFinal)`, so a missing final chunk is detected (STREAM construction). Default chunk size 1 MiB.
- **Integrity:** recipient checks `ciphertextSha256` before decrypting and `plaintextSha256` after.
- **Where ciphertext goes (D-48, D-49):** files ≤ 12 KB travel inline; larger files go to the 4thTech **encrypted drop** by default, or to the user's own storage (S3-compatible; Google Drive, Dropbox or OneDrive from M2), chosen by policy `files.storage` (06 §3, 07 §5.6). Every backend receives only the ALF1 ciphertext. The file key, file name and `plaintextSha256` travel only inside the end-to-end-encrypted envelope (I-2); the backend sees only the ciphertext, its hash and its own download URL, which reaches the recipient only inside the envelope.
- **Delivery:** a download URL valid until `expiresAt`: an S3 presigned GET, a signed drop URL or a provider share link. **Default and maximum expiry: 7 days** (the SigV4 limit; temporary credentials expire sooner), enforced by the drop and by S3-compatible storage. Consumer connectors (D-49) cannot always enforce link expiry: the sender's agent creates the share link, then deletes the object and revokes the link at expiry or on receipt, per `files.deleteAfter`. That is best effort (it needs the sender's device online); the content stays encrypted. A recipient can request a fresh link with a `request` envelope (`body.kind = "refresh-link"`), which the sender answers when online.
- **Retention and crypto-shredding:** policy `files.deleteAfter` = `expiry` (default) or `receipt`. When triggered, the sender deletes the object and both sides delete the `fileKey`. This protects against storage remnants; it cannot force a recipient who already decrypted a copy to delete it.
- **Owner archive (P1):** policy `files.ownerArchive: true` lets owners keep file contents beyond expiry. The sender's core re-uploads the ciphertext to the owner's own storage, keyed to the owner, before deletion. The drop is never an archive target.
- **Encrypted drop (D-48).** A 4thTech Cloudflare Worker in front of an R2 bucket (protocol in 07 §5.4). Its rules:
  - **Signed uploads, no accounts.** Every drop request is signed through the `KeyStore` with the agent's dedicated **drop key** (§2.1), never with its Nostr or EVM identity key, so the drop cannot link uploads to the agent card, the EVM address or a billing profile. The upload request is signed over method, host, size, expiry, a nonce and a timestamp; the commit that completes it is signed over the object ID and `ciphertextSha256`, which the core computes while it streams the ciphertext (07 §5.4). The format is domain-separated and fixed with test vectors. The Worker verifies each signature and rejects replays (nonce plus a short time window). Signatures travel in a header or the body rather than the URL. No request carries a file name, owner key, recipient or other file metadata.
  - **Random object keys.** The Worker assigns a random 128-bit object ID; no file names, agent IDs or contact data appear in object keys or object metadata.
  - **Limits.** A size cap per file (proposed 100 MB), a weekly quota per drop key (proposed 1 GB), rate limits per drop key and per IP (IPv6 counted per /64), and a global cap. The upload target accepts exactly the declared size. Residual risk (sybil): new drop keys are free, so one abuser can spread uploads over many keys; the per-IP limits and the global cap bound this. `DECISION NEEDED (owner)`: stronger anti-abuse if needed, for example proof-of-work or rate-limited admission of new drop keys.
  - **Expiry and deletion.** A hard 7-day expiry from upload: downloads are refused after `expiresAt`, and an R2 lifecycle rule deletes every object as a backstop. Retention follows `files.deleteAfter` as for any storage, not a forced delete on receipt: by default (`expiry`) the object stays until it expires, so owners keep access to file contents until then (I-9); with `receipt`, an owner option, the sender's core deletes it on receipt with a DELETE signed by the uploading drop key. Both sides discard the file key as for any storage (crypto-shred).
  - **Download URLs and serving.** A signed GET URL bound to the object ID and `expiresAt`, returned only to the uploader and carried only inside the envelope; clients treat it as a secret (I-7). Objects are served only as `application/octet-stream` with `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff` and a sandboxing CSP, from a dedicated host, so the drop can never serve a web page. The recipient's SSRF rules below apply unchanged: the drop host is an ordinary HTTPS host, never trusted or exempted.
  - **Logging (I-7).** Aggregate counters only. No request URL, signed URL, object ID, drop key or upload signature appears in any log, metric label or analytics, with or without IPs; request bodies are never logged. In production, Workers observability and request logging, Tail Workers and Logpush stay off for the drop Worker, read back after each deploy. Residual risk: Cloudflare, as the infrastructure operator, can see request metadata (IPs, times, URLs); contents stay protected because they are ciphertext, and I-7 governs our own logging.
  - **Abuse.** Quotas, expiry, a per-object download limit (proposed 10) and a report path: a report deletes only that object; blocking a drop key needs human review, is rate-limited and can be appealed; the report path never asks for or accepts file keys, envelopes or plaintext. Contents cannot be inspected, because they are ciphertext. `DECISION NEEDED (owner)`: terms of service and takedown process (counsel review).
  - **Compromise.** A fully compromised drop can deny, delete or delay delivery (I-3). It cannot read files (no file key) or alter them undetected (`ciphertextSha256`, `plaintextSha256`). The sender can resend through own storage.
- **Consumer storage connectors (D-49, M2).** Google Drive, Dropbox and OneDrive adapters in the desktop apps (07 §5.5):
  - **OAuth.** Authorization code with PKCE and a loopback redirect (`127.0.0.1`, random port) in the system browser, never an embedded webview. Minimal scopes: an app folder or app-created files only. Connecting adds storage credentials, so it is an owner operation (I-4, §2.5).
  - **Token storage.** Refresh and access tokens stay on the device in the OS keychain (in the desktop app, bound to the signed app where the OS allows, §2.2). They are never sent to 4thTech, never logged, never stored in plaintext in the local store, and not part of the recovery kit (the user reconnects after a restore).
  - **Objects.** ALF1 ciphertext only, with random 128-bit names, in a dedicated app folder; no file names, contact data or descriptions.
  - **Share links.** Created per file by the sender's agent and expiring at `expiresAt` where the provider supports it. Where it does not, the sender's core revokes the link and deletes the object at expiry or on receipt (per `files.deleteAfter`), which works only while the sender's device is online: best effort, and the content stays encrypted. `DECISION NEEDED (owner)` per provider (07 §5.5). A share link opened in a browser may reveal the sender's provider account name; the connect screen says so.
  - **Fetching.** The SSRF rules below apply unchanged to provider hosts, including the redirect cap.
- **Downloads:** written only into the configured inbox folder, never executed; names sanitized (strip paths and control characters, no hidden files).
- **SSRF protection (`fetch_file`):** URLs must be `https`. Hosts resolving to loopback, private, link-local (incl. `169.254.169.254`) or unique-local addresses are rejected. Redirects are capped at 2 and re-checked; download size is capped at the declared size plus overhead.
- **Allowed folders:** paths are resolved with `realpath` (symlinks followed) and must remain inside an allowed folder after resolution. Hidden files and files under `~/.ssh`, `~/.agentlink` and the keychain directories are always refused.

---

## 5. On-chain records

- Record and Receipt structs are defined in `05-contracts-occ-v2.md`. EIP-712 domain `{name: "OCC", version: "2", chainId, verifyingContract}`. Structs include an explicit `signer` field, so EOAs and ERC-1271 smart accounts verify the same way.
- **Recipient commitment:** `keccak256(abi.encode(recipientAgentEvm, salt))`; the 32-byte salt is delivered in the encrypted `proof` envelope. The public cannot link a record to its recipient unless a receipt is posted (receipts reveal the recipient's agent address; see 05 §3.3).
- **Records:** random 256-bit nonce per signer, single use; `deadline` enforced. **Receipts:** one per type per record (flag), `deadline` enforced.
- On-chain data is minimal: no content, file names or display names.

---

## 6. Forward secrecy (explicit trade-off)

Static recipient keys mean a stolen encryption key decrypts past envelopes addressed to it. This is accepted for beta because owners must be able to read history (I-9) and agents run asynchronously. Mitigations: keychain storage, key rotation (epochs), short file expiry, crypto-shredding. A later version may use per-epoch keys with owner escrow.

---

## 7. Threat model

| Threat | Mitigation |
|---|---|
| **Malicious or compromised relay** | Gift wraps hide sender and content; multiple relays; signature verification; dedup by envelope ID |
| **Malicious storage provider** (own storage) | Ciphertext only; hash checks; expiring URLs |
| **Malicious or compromised encrypted drop** (D-48) | Ciphertext only; the file key travels only in the end-to-end-encrypted envelope; `ciphertextSha256` and `plaintextSha256` checks; signed, expiring URLs; at worst it denies, deletes or delays delivery (I-3), and the sender can resend through own storage. The metadata it sees (drop key, sizes, times, IPs) is minimised: the drop key is unlinkable to the agent's public identity, and only aggregate counters are kept, never URLs, object IDs or keys (§4) |
| **Drop abuse / free storage misuse** (hosting malware or illegal content, quota farming with fresh drop keys) | Per-file size cap and weekly quota per drop key, backed by per-IP rate limits and a global cap (residual sybil risk, §4 Limits); hard 7-day expiry; per-object download limit; objects served only as `attachment` octet-stream from a dedicated host (no web pages); a report path that deletes the object (blocking a key needs human review); contents cannot be inspected (ciphertext). `DECISION NEEDED (owner)`: terms of service and takedown process (counsel) |
| **Consumer storage account compromise or over-broad OAuth scope** (D-49) | Minimal scopes (app folder or app-created files), so a stolen token reaches only AgentLink ciphertext; tokens only in the OS keychain (bound to the signed desktop app where the OS allows), never sent to 4thTech or logged; a compromised account can read only ciphertext and can delete or replace it, which the hash checks detect; the owner can revoke the app at the provider. A provider whose sharing API needs a broader scope ships only after an owner decision (07 §5.5) |
| **Malicious submitter** | Cannot alter signed records; can only censor → client fails over to another submitter or direct mode |
| **Network observer** | TLS everywhere; content already E2E-encrypted |
| **Compromised 4thTech web host serving malicious console JS** | Open source, reproducible builds, published hashes, SRI, CSP; self-hostable console; local packaging avoids the web entirely. Residual risk documented |
| **Shell-capable harness agent (same OS user)** | Owner key never on disk unwrapped; owner operations need passkey/passphrase (§2.5); signed policies; harness permission guidance; small credit balances |
| **Malicious counterparty: prompt injection** | Inbound content labelled `untrusted`; actions limited by owner-signed policies; new contacts need owner approval by default; files only from allowed folders; spending budgets |
| **Malicious counterparty: spam / flooding** | Allowlist by default; unknown senders → requests queue; per-contact rate limits; envelope size cap |
| **Malicious counterparty: SSRF via file URLs** | §4 SSRF rules |
| **Malicious files / symlink tricks** | Never executed; sanitized names; realpath checks; size limits |
| **Stolen laptop** | Keychain protection (OS login); owner key needs passkey/passphrase; owner can revoke the agent (revocation envelope + on-chain revoke if registered) |
| **Phishing invites** | Invites show name, owner fingerprint and safety code; expire; single use; owner approval by default |
| **Replay of records / receipts / authorizations** | EIP-712 domain, nonces, deadlines, one-time receipt flags; EIP-3009 nonces |
| **Abuse of a public agent card** (e.g. registering it with attacker fees) | Registration requires a separate owner signature over fee parameters (05 §4) |
| **Submitter gas griefing** | Simulate before submit; require on-chain credits; per-signer rate limits; minimum deposit for gasless top-ups |
| **Supply chain (npm)** | Minimal dependencies, pinned lockfile, npm provenance, 2FA, reviewed updates, no postinstall scripts in our packages |
| **On-chain metadata analysis** | Pseudonymous agent keys, salted commitments; per-relationship keys (P2) |
| **Agent commits its owner to terms** (prompt injection or an over-eager agent) | Policy `commitments.accept` defaults to `approval` (D-31); auto-accept only for allowlisted contacts up to a maximum value; the approval screen shows the terms and the changes from the previous version; `termsHash` binds exactly what was accepted (§3.4) |
| **Local page imitating the approval page** (shared `localhost` passkey RP ID) | The owner's gesture is still required; the desktop app (M2) replaces the localhost page with a native window and a keystore bound to the signed app (§2.5) |
| **Spoofed or lapsed domain claim** | Owner-signed claim checked against the contact's owner key; periodic re-check with downgrade and warning; exact domain shown; SSRF rules on `.well-known` fetches (§2.7) |
| **Malicious desktop app update** | Updates signed with a key pinned in the app and verified before install; OS code signing and notarization; no downgrades; reproducible builds with published hashes; releases need owner approval (08 §8) |

---

## 8. Engineering rules

1. Our code never calls crypto primitives directly. It uses `@agentlink/crypto`, and secret-key operations go through the `KeyStore` interface (sign, NIP-44 encrypt/decrypt, HPKE open). Vetted dependencies that use primitives internally are allowlisted: `nostr-tools`, `viem`, `@noble/*`, `@hpke/core`, `aws4fetch`.
2. Test vectors for key derivation, envelope hashing/signing, HPKE wrapping, file STREAM encryption, pairing proof and EIP-712 hashes are committed and checked in CI across Node, browser (Playwright) and Workers (Miniflare).
3. Secrets are wiped from memory where the platform allows (`fill(0)` on `Uint8Array`).
4. A redacting logger is used everywhere; a CI test asserts known secret patterns never appear in logs.
5. Independent security review of `@agentlink/crypto`, `@agentlink/core` and the contracts before mainnet (M3 gate).
