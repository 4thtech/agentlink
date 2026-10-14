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
| Local, headless (no OS keychain; opt-in, D-54) | Passphrase-locked **file KeyStore** in `~/.agentlink/keystore/` (Argon2id + AES-256-GCM, §2.8). Only where no OS keychain is usable **and** the user opts in; never chosen silently | **Never stored in plaintext.** If present: `~/.agentlink/keystore/owner.alko`, wrapped with a **generated 120-bit owner code** (no chosen passphrase, because copies of the machine carry the file), created in a separate owner step and unlocked only at an interactive prompt or with a passkey, never from an environment variable or file (§2.8). M2 default (proposed): not present; the owner approves from their own device (console) |
| Self-host Worker | Worker secret / Durable Object storage in the **user's** Cloudflare account | Not present |
| Console (browser) | — | IndexedDB, wrapped with a key derived from the owner passkey's **PRF** output |

Headless machines (containers, WSL, SSH sessions) without a usable OS keychain follow §2.8.

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

**Card JSON form.** The card travels (invite, `handshake`, `card-update`, proof pack) and is hashed (`sha256(JCS(card))`, §3.6) as its EIP-712 message object: exactly the twelve fields above, with these names and no others, encoded per §2.4.1. It is I-JSON (RFC 7493), so a duplicate key is rejected. Every address and `bytes32` field, including `agentNostr`, `ownerNostr`, `agentEnc` and `ownerEnc`, is `0x` + lowercase hex; `version`, `issuedAt`, `expiresAt` and `keyEpoch` are JSON integers. `cardSig` is the owner's EIP-712 signature over the card's digest under the domain above, in the canonical ECDSA form of §2.4.1.

#### 2.4.1 Canonical binary encodings (proposed; owner confirms at merge)

Every binary value has exactly one spelling. The rule covers every JSON object the protocol signs, hashes, sends or exports: cards, owner actions, envelopes, payload bodies, proof packs and tool results. Non-JSON carriers (the DNS TXT record of §2.7) keep their own stated form.

**Decision rule, per schema path** (proposed; owner confirms at merge). Each JSON path in each schema has exactly one encoding. A decoder is chosen by schema and path, never by field name alone, because some names are reused with different meanings (listed below). For each path:
1. **`0x` + lowercase hex** if the value is ever an EIP-712 field or an ABI value: it goes on-chain, into a Record or Receipt, or into an EIP-712 message. A value that appears in both worlds uses `0x` on every path that carries it. Examples: `envelopeHash` (in a commitment scope and in a Record), and `recordId` and `salt` (in the `proof` body and on-chain).
2. Otherwise, **bare lowercase hex** if the value is a Nostr value, or a digest that is only ever signed or verified under a Nostr key (BIP-340: envelope `sig`, owner-action `sig`).
3. Otherwise, **base64url without padding** (§3.1).

An object embedded in another one keeps its own bytes. For example, a proof pack carries a `SignedOwnerAction` or a disclosed envelope verbatim, so their paths keep the forms below. Being inside a pack never re-encodes a value. A new path that would enter a Record or an EIP-712 message is `0x` from its first version. An existing bare-hex path never moves on-chain under the same name.

| Encoding | Schema paths |
|---|---|
| `0x` + 40 hex (address) | OwnerAction `agent`; `contact.check` `params.contact`; tool-result contact and agent `id` (06 §2.1); `approval-request.agent`; `terms.parties[]`, `terms.deliverables[].by`, `terms.price.payer`; CommitmentScope `agentId` and `counterparty.agentId`; policy `contacts.allowed[]`, `commitments.autoAcceptContacts[]` and `contactRules[].contact` (06 §3, G-32); AgentCard `agentEvm`, `ownerEvm`; proof pack `notary`, `signer.evm`, `recipient.evm`, `receipts[].signer`; Record and Receipt `signer`, Record `feeToken`; `ProofStatus.fee.token` and `approval-request` `action.context.fee.token` (06 §2.4); EIP-3009 `auth` addresses (07 §7) |
| `0x` + 64 hex (`bytes32`) | `proof` body and proof pack `recordId`; `handshake-ack` `handshakeHash` (an `envelopeHash`, rule 1); `proof` body `salt` and proof pack `recipient.salt`; CommitmentScope `answers.envelopeHash`, proof pack `envelopeHash`; Record `envelopeHash`, `recipientCommitment`, `parentRecordId`, `appId`; Receipt `recordId`, `salt`; `recordStructHash`; `txHash` everywhere; AgentCard `agentNostr`, `agentEnc`, `ownerNostr`, `ownerEnc`, `nameHash`, `relaysHash`; `DomainClaim` `ownerNostr` (§2.7); EIP-712 digests and struct hashes; EIP-3009 `auth.nonce`, `auth.r` and `auth.s` (07 §7) |
| `0x` + hex (ECDSA signature) | invite, `handshake`, `handshake-ack` and `card-update` `cardSig`; invite and `handshake` `cardAgentSig` (§2.9); proof pack `signature` and `signer.cardSig` (07 §8); submitter `records[].signature` and `receipts[].signature` (07 §7) |
| Decimal string (`uint256`) | Record `maxFee`, Record `nonce`; `ProofStatus.fee.amount` and `approval-request` `action.context.fee.amount` (token base units, 06 §2.4); EIP-3009 `auth` amounts and times |
| USD amount (decimal string; G-7, G-32; proposed, owner confirms at merge) | policy `proofs.dailyBudgetUSD`, `proofs.perActionMaxUSD`, `commitments.autoAcceptMaxUSD`, `commitments.autoAcceptMinUSD`, `contactRules[].proofs.perActionMaxUSD` (06 §3); CommitmentScope `maxFeeUsd`; `approval-request` `action.context.fee.usd`; `ProofStatus.fee` `usd`, `protocolUsd` and `integratorUsd`; `agentlink_status` `prices[]` `usd`, `protocolUsd` and `integratorUsd`; the budget ledger's amounts. Exactly one spelling: `^(0\|[1-9][0-9]{0,8})(\.[0-9]{0,5}[1-9])?$`, so there is no trailing zero after the point and no bare point (`"0.1"`, `"5"`, `"1.000001"`; never `"0.10"`, `"5.0"` or `"5."`), at most 6 decimals (USD stablecoin precision) and at most 999 999 999.999999. A JSON number is rejected. Values are compared and added as exact decimals (for example integer micro-dollars), never as binary floats. Producers convert from exact values: a fee from token base units at 1:1 (D-46), a rounded-up value (such as "Remember for this contact", 06 §3) after rounding |
| Bare hex, 64 (Nostr key) | envelope `from`; OwnerAction `owner`; CommitmentScope `counterparty.ownerKey`; Nostr event ids |
| Bare hex, 128 (BIP-340) | envelope `sig`; `SignedOwnerAction` `sig` |
| Bare hex, 64 (digest under a Nostr key only) | `approval-request.actionDigest` and `approval.decide` `params.actionDigest`; `terms` bodies' `termsHash` and `terms.previousTermsHash`; CommitmentScope `termsHash`; `files[].plaintextSha256`, `terms.deliverables[].plaintextSha256`, `files[].ciphertextSha256`, drop commit `ciphertextSha256`; proof pack `ownerApproval.policyHash`; `handshake` `inviterCardHash`; `contact.check` `params.pairingDigest` (§3.6.1) |
| base64url | envelope `id`, `thread`, `recipients[].kid`, `.enc`, `.wk`, `aead.iv`, `aead.ct`; payload `replyTo`, `files[].inline`, `files[].fileKey`; `proof` body `envelopeId`; CommitmentScope `answers.envelopeId`, `thread`, `termsId`; `terms.termsId`; invite `inviteId`, `secret`; `handshake` `inviteId`, `proof`, `codeNonce`, `codeCommit`; invite `codeCommit`; `handshake-ack` `inviteId`, `handshakeId`, `codeReveal`; OwnerAction `nonce`; drop request `nonce`; proof pack `disclosure.contentKey` |
| Prefixed string (not binary) | `approvalId` everywhere (`approval-request`, `approval.decide` and `approval.cancel` `params`, tool inputs and results): exactly `apr_` followed by the base64url (no padding) of 16 random bytes, 26 characters in total, matched exactly |
| Tool results (06 §2) | Use the row of the protocol path they mirror: `ProofStatus.recordId` and `txHash`, and `agentlink_verify_proof_pack` `recordId` and `envelopeHash`, are `0x` + 64 hex; `signer` there is a `0x` address; `termsHash` is bare hex; `envelopeId` is base64url |

**Overloaded names.** The same name on a different path means a different thing:
- `nonce`: base64url in an OwnerAction or a drop request, a decimal string in a Record, and `0x` `bytes32` in an EIP-3009 `auth`.
- `sig` / `signature`: `sig` is a BIP-340 signature in bare hex on an envelope and a `SignedOwnerAction`. `signature` is an ECDSA signature in `0x` form in a proof pack and in the submitter bodies (07 §7).
- `id`: an envelope `id` is base64url, while `terms.deliverables[].id` is a short free string (`"d1"`), not binary.
- `agentId`: the agent's EVM address on every path (`terms`, CommitmentScope, tool results), and the same address as text in the keychain account, the `.alks` file name and its header (§2.9, G-23). There is no separate local handle.
- `signer`: an address in a Record, a Receipt and a proof pack's `receipts[]`, but an object `{evm, agentCard}` at the top of a proof pack.

**Canonical ECDSA signatures** (proposed; owner confirms at merge). Every 65-byte secp256k1 ECDSA signature (`cardSig`, a proof pack `signature`, and Record and Receipt signatures from an EOA) is `r || s || v`, with:
- `r` and `s` in [1, n − 1];
- `s ≤ n/2` (EIP-2 low-s), which verifiers check themselves, because viem and noble recovery accept a high `s`;
- `v` ∈ {27, 28}.

Any other form is rejected, for example `v` ∈ {0, 1}, a high `s`, or a length other than 65 bytes. An ERC-1271 signature has the length its account returns: `0x` followed by a non-empty, even number of hex characters.

**Other decimal amounts.** `terms.price.amount` (§3.4) is an amount in the terms' own currency, written by a party and hashed as written. It keeps its D-55 grammar (`^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$`, greater than zero), which allows trailing zeros such as `"1500.00"` and has no fixed upper bound beyond the M1-21 size limits. Comparing it with a USD limit (auto-accept, §3.4.2) uses the same exact-decimal helper, which must handle an amount far above any limit without overflow or rejection: such an amount is simply above the limit.

**Hashes that reach a Record.** The Record and Receipt commit only `envelopeHash`, `recipientCommitment` (from `salt`), `parentRecordId` and `appId`. Files and terms reach the chain only through `envelopeHash`. `termsHash`, `plaintextSha256` and `ciphertextSha256` are never Record fields, so they stay bare hex on every path, including inside a disclosed envelope in a proof pack.

- **The path decides, not the key it holds.** A Nostr key inside an EIP-712 message is a `bytes32` there. The card's `ownerNostr` is `0x` + 64 hex, while the same key as an OwnerAction `owner` or an envelope `from` is 64 hex without a prefix.
- **Producers encode from bytes.** A value copied from one path to another, for example a card's `ownerNostr` into a CommitmentScope `counterparty.ownerKey`, is decoded to bytes and encoded for the target path through `@agentlink/types`, never by editing the string.
- **Compare bytes, never strings.** Each value first passes its strict parse. Every equality between two encoded values then decodes both to bytes and compares the bytes. Examples: OwnerAction `owner` with the card's `ownerNostr` (§2.5.1, §3.4.1 `revoke`), envelope `from` with the card's `agentNostr` (§3.4.1), the seal key with `from` (§3.5), and a stored card's fields with a new card's (`card-update`). Nothing re-encodes, trims or lower-cases a value in order to compare it. `@agentlink/types` provides the decoders, so no caller writes its own conversion.
- **Non-canonical forms are rejected on parse, never normalised:**
  - upper-case or mixed-case hex, including EIP-55 checksummed addresses (checksums are for display only);
  - a missing `0x` on a `0x` field, a `0x` on a bare-hex field, and `0X`;
  - a wrong length, or whitespace anywhere;
  - base64url with padding, `+` or `/`, or non-zero trailing bits;
  - for `uint256` decimal strings, anything that does not match `^(0|[1-9][0-9]*)$` (so `"0"` is valid; signs, leading zeros, fractions, exponents and whitespace are not), or a value above the type's maximum.
- **Integers** other than `uint256` are JSON integers in [0, 2^53 − 1], including the card's `uint8`, `uint32` and `uint64` fields. A `uint64` value above 2^53 − 1 is rejected.
  - The JSON token itself must match `0|[1-9][0-9]*`, so `1.0`, `1e3`, `-0` and `9007199254740991.4` are rejected in every runtime.
  - Parsers check the token with `JSON.parse` source-text access or a strict tokenizer, not only the parsed value, which differs across runtimes for such tokens.
- **Test vectors (M1-1h).** M1-1h carries accept and reject vectors for each row of the table:
  - the canonical form of each path listed above;
  - each non-canonical form above, applied to a path of each row, including the integer tokens `1.0`, `1e3`, `-0` and `9007199254740991.4`;
  - ECDSA: a high `s`, `v` ∈ {0, 1} and a 64-byte signature are rejected;
  - the cross-class cases: a card `ownerNostr` and an OwnerAction `owner` for the same key compare equal as bytes; an `owner` with `0x`, and a card key without it, are each rejected; a `proof` body whose `recordId` or `salt` is base64url is rejected.

### 2.5 Owner operations and user presence

Owner-only operations: approve/deny, change policies, add/remove allowed folders, add storage credentials, export keys, revoke agents, disclose content keys, mark a contact's safety code as checked (§3.6.1).

- Each is expressed as an **owner-signed object** (`SignedOwnerAction`, §2.5.1, signed by the owner Nostr key). The local UI, the CLI and the console produce the same object. The console carries it inside an `approval`, `policy` or `revoke` envelope (§3.4.1); the envelope is only transport, and authority comes from the object's owner signature, never from the envelope signature.
- The agent's core **verifies the owner signature** against the owner key in its agent card before applying the action. Policies are stored as signed documents and re-verified on load, so editing the database directly has no effect.
- Signing requires user presence: passkey (local UI on `localhost` or console) or owner passphrase (CLI prompt). The local UI holds no reusable bearer token on disk.
- **Desktop app owner presence (M2, D-36)** is stronger than localhost WebAuthn. Known weakness of the localhost passkey: a WebAuthn RP ID is a host name without port, so a passkey registered for `localhost` can be requested by any page on any localhost port, including one a shell-capable agent starts. Such a page could imitate the approval page and ask for the owner's gesture (the human must still complete the prompt). The desktop app removes this path: owner operations happen in a **native approval window** (not a localhost page), the OS prompt names the signed app, and the keystore releases the owner wrapping key only to that app (§2.2). Residual: on Linux, and wherever the OS falls back to a typed device password, an agent able to inject keystrokes and knowing the secret could complete the prompt; this is settled in the framework security review (08 §8).
- **Commitments (D-31)** are an approval path, not an owner-only operation. Sending an `accept` and signing an `ACCEPTED` or `REJECTED` receipt are agent actions gated by policy `commitments.accept` (default `approval`, 06 §3): the agent proposes, the owner approves or denies through the normal approval flow above (owner-signed, with presence), and only then does the agent's key send or sign. Auto-accept applies only within owner-signed limits (allowlisted contacts, maximum value). One approval covers one agreement, bound to its exact terms (§3.4.2, D-55).
- **Residual risk:** an agent with unrestricted shell access as the same OS user could tamper with the AgentLink installation itself or spend the agent's credits by signing records with the agent key. Mitigations: keep credits small; harness permission settings that deny access to `~/.agentlink` and the keychain (documented in the quickstart); owner revocation; per-agent spending caps in the vault (P2).

#### 2.5.1 Owner-signed objects (decided, D-58; G-29)

```jsonc
// OwnerAction: the signed content
{
  "v": 1,
  "agent": "0x<40 lowercase hex>",          // the agent's EVM address (stable, §2.1)
  "owner": "<64 lowercase hex>",            // owner Nostr x-only pubkey; equals, as bytes, ownerNostr in that agent's card (§2.4.1)
  "op": "approval.decide | policy.set | agent.revoke | …",
  "params": { },                            // strict schema per op
  "nonce": "<16 bytes, base64url, no padding>",
  "issuedAt": 1760000000,
  "expiresAt": 1760000600                   // 0 for agent.revoke, and only for it
}
// SignedOwnerAction
{ "body": { /* OwnerAction */ }, "sig": "<128 lowercase hex: BIP-340 signature>" }
```

- `sig` = BIP-340 Schnorr by `owner` over `taggedHash("agentlink/owner-action/v1", sha256(JCS(OwnerAction)))`. The tag differs from the envelope tag (§3.1), so an owner-action signature is never a valid envelope or Nostr event signature, and the reverse.
- **Encoding (byte-exact, §2.4.1).**
  - `agent` is `0x` followed by 40 lowercase hex characters (EVM-native). `owner` is 64 lowercase hex characters and `sig` is 128, both without a prefix (Nostr-native).
  - `nonce` is 16 bytes, base64url without padding.
  - Integers (`v`, `issuedAt`, `expiresAt`, `policy.set` `version`) are JSON integers in [0, 2^53 − 1].
  - All strings are I-JSON (RFC 7493), and JCS is RFC 8785.
  - Schemas are strict at every level (`SignedOwnerAction`, `OwnerAction`, `params`), so unknown keys are rejected.
  - An object in any other form is **rejected, never normalised**.
  - The same lowercase address form applies wherever an agent address appears in a signed or hashed object: `terms.parties` (§3.4) and `approval-request.agent` (§3.4.1).
  - M1-1h carries signing vectors and rejection vectors for every non-canonical form (checksummed or uppercase address, uppercase hex, a `0x` on `owner` or `sig`, padded base64url, out-of-range integer, unknown key), plus the §2.4.1 cross-class cases.
- **Binding.** `agent` binds the action to one agent by its canonical EVM address (decided, D-58). The address is stable across epochs and covered by the agent card signature and the Registry. `agentId` (G-23, §2.9) is this same address, so it is never a second binding. An action signed for one agent is refused by every other agent of the same owner.
- **Verification** (core, before applying). "The agent" means the receiving core's own agent, or, for `agent.revoke` at a contact, that contact's stored card (§3.4.1). Checks, in order:
  - the encoding above is exact;
  - `agent` is that agent's EVM address;
  - `owner` equals `ownerNostr` in that agent's card, compared as bytes (§2.4.1: the card spells it `0x` + 64 hex, `owner` has no prefix);
  - `sig` is valid;
  - `issuedAt` is not in the future beyond clock skew;
  - `now ≤ expiresAt`, and `expiresAt − issuedAt` is within the op's maximum lifetime;
  - `nonce` is unused;
  - `params` match the op's schema.

  Any failure drops the object (fail closed). `expiresAt` = 0 is required for `agent.revoke` and allowed only there; that op skips the expiry and lifetime checks. Nonces are retained for at least the maximum lifetime plus skew. Skew, lifetimes and retention are fixed below (G-7).
- **Lifetimes, skew and nonces (G-7; proposed, owner confirms at merge).** All times are unix seconds, as JSON integers (§2.4.1). "Now" is the verifying core's own system clock; no 4thTech time service is used.
  - **Clock skew `S` = 300 s.** It applies only to `issuedAt`: the core refuses `issuedAt > now + S`. Expiry has no skew: the core refuses `now > expiresAt`. The schema requires `issuedAt < expiresAt` for every op except `agent.revoke`.
  - **Maximum lifetime `L(op)`.** The core refuses `expiresAt − issuedAt > L(op)`. A signing surface sets `expiresAt` at most `issuedAt + L(op)` and may choose less. The local UI and the CLI apply an action within seconds. The long values exist for the console, whose `approval`, `policy` and `contact.check` objects reach a local agent over relays, possibly after the machine wakes up.

    | `op` | `L(op)` | Why |
    |---|---|---|
    | `approval.decide` | `expiresAt` must also be ≤ the pending request's `expiresAt` (§3.4.1), which is at most 24 h after `requestedAt`; so `L` = 86 400 s | A decision is useless after its request expires |
    | `approval.cancel` | 604 800 s (7 days) | It only voids. It must still reach an offline agent before the scope it cancels expires (at most 7 days, §3.4.2) |
    | `policy.set` | 86 400 s (24 h) | Rollback is stopped by `version`, not by freshness. 24 h bounds how long an unapplied policy, signed on the console, can still surprise the owner. After that the console says "not applied, sign again" |
    | `contact.check` | 86 400 s (24 h) | As for `policy.set` (console from M2) |
    | `agent.revoke` | none (`expiresAt` = 0) | Permanent and idempotent |
    | any later op (storage credentials, key export, content-key disclosure) | 600 s (10 min) unless the task that defines it sets another value | Short by default (fail closed). No op may exceed 604 800 s |
  - **Nonces.** The core records an action's `nonce` when it applies the action, per agent, in the store (G-9). It keeps the nonce for at least 30 days after applying it; 30 days exceeds the longest `L(op)` plus `S`. A nonce that is already recorded refuses the object. Checking the nonce, recording it and applying the action happen in one store transaction (SQLite, or Durable Object storage), so two concurrent deliveries of one object apply it at most once. `agent.revoke` is exempt: revocation is permanent, and a contact applies a re-published copy as a no-op (§3.4.1), so a repeat is never an error. Residual: a same-OS-user process that deletes nonce rows can replay an unexpired action (G-1). That replay is bounded by `L(op)`, by single use of each `approvalId`, and by `version` for `policy.set`.
  - **Constants.** `@agentlink/types` exports `S` and each `L(op)`. Verification lives in the core (M1-7d) and is pure, with `now` passed in, so the boundaries can be tested exactly.
- **Refusals are reported.** An owner action the core refuses (expired, superseded version, unknown approval) is reported to the owner: a local UI notice, or on the console "not applied, sign again". It never fails silently.
- **Stored objects are re-verified, not trusted.**
  - Freshness and nonce checks apply once, when an action is first applied.
  - **Policies.** On every load, the stored `policy.set` must verify (`sig`, `agent`, `owner`). Its `version` must equal the **highest applied version**, which the core keeps as a KeyStore item (§2.2, §2.8), not only in the store. Otherwise G-6 applies, and once any version has been applied, the result is never the 06 §3 defaults. Residual: a same-OS-user process can roll back both the store and the KeyStore item (G-1).
  - **Approvals.** The core stores the signed `approval.decide`. When a tool presents an `approvalId`, the core re-verifies that object (`sig`, `agent`, `owner`, `approvalId`) and recomputes `actionDigest` from the current call, instead of trusting a status column.
- Ops defined here (others, such as storage credentials, key export and content-key disclosure, use the same object with `params` fixed by the tasks that build them):

| `op` | `params` | Produced by | Rules |
|---|---|---|---|
| `approval.decide` | `{approvalId, actionDigest, decision: "approve" \| "deny"}` | Local UI, CLI, console (`approval` envelope) | Applies only to a pending request with the same `approvalId` and `actionDigest` (§3.4.1); single use. Its maximum lifetime is the request's `expiresAt`. A deny is signed too, so a forged deny cannot cancel a request |
| `approval.cancel` (D-55) | `{approvalId}` | Local UI, CLI (`agentlink cancel`), console (`approval` envelope), desktop app | Voids the unused parts of an approved commitment scope (§3.4.2), for example a receipt still waiting for the offer's record. It also voids any other approved approval that has not been used yet (G-7; proposed, owner confirms at merge); a used one has nothing left to void, and a pending one is denied instead. Single use. It can only void: it never approves, revives or widens anything |
| `policy.set` | `{version, policy}` | Local UI, CLI, console (`policy` envelope) | `policy` is the complete 06 §3 document, never a partial patch, in the policy JSON form of 06 §3 (G-32; proposed, owner confirms at merge). Every key is present, unknown keys are rejected, USD limits are decimal strings and contact IDs are agent IDs. The strict schema is built in M1-2b (`@agentlink/types`). Signing vectors use the 06 §3 defaults in that JSON form as `policy`, and one vector also carries a non-empty `contactRules`. `version` must be greater than the highest applied version, so an older signed policy cannot be replayed to roll back. After applying, the core echoes the signed object to its owner on the owner channel (§3.4.1), so the console always knows the current version, including one set from the local UI or the CLI. Fail-closed behaviour on a missing or invalid policy stays with G-6 |
| `agent.revoke` | `{reason: "compromised" \| "retired" \| "other"}` | Console (any reason); CLI only on an uncompromised machine (`revoke` envelope) | Permanent per `agent` EVM address, for every epoch, with no un-revoke (decided, D-58). A revoked agent returns only as a new identity (new seed) with new pairings, and the UI asks for explicit confirmation. `reason` is a fixed value, never free text. Delivery to contacts: §3.4.1 |
| `contact.check` (G-28; proposed, owner confirms at merge) | `{contact, pairingDigest}` | Local UI, desktop app, CLI (`agentlink contacts --verify <id>`, †, interactive terminal only); console from M2 (M2-2e) | Marks the contact "Safety code checked" (11 §5.2) after the owner compared the code (§3.6.1). `contact` is the contact's `agentId` (§2.9). `pairingDigest` is the transcript digest of its current pairing, which the signing surface has just recomputed from the signed `handshake` and `handshake-ack` (§3.6.1), as 64 lowercase hex. Applied only if both match a completed pairing, recomputed the same way. The core stores the signed object and re-verifies it on every load against a fresh recomputation, never against a stored digest, so a database edit can neither set the label nor change the code behind it. A completed re-pair (new digest) clears it. Idempotent. Maximum lifetime 24 h, as for `policy.set` (G-7) |

### 2.6 Key rotation

- A new `keyEpoch` derives new Nostr and encryption keys (EVM key unchanged) and issues a new agent card. Old epoch keys are re-derivable from the seed, so history stays readable.
- Signing and encryption always use the current epoch. Decryption picks the epoch from the recipient `kid` or the gift wrap's `p` tag. A new envelope is accepted only from the sender's current key, except a `card-update` (§3.1.1, G-2; proposed, owner confirms at merge).
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

### 2.8 Headless file KeyStore (D-54, G-31)

Coding agents often run where no OS keychain is usable: Linux containers and devcontainers, WSL, SSH sessions, servers without a desktop session (no Secret Service), and macOS over SSH with a locked login keychain. For these machines the agent's keychain items (the agent seed, the store key of 07 §3 and any S3-compatible storage credentials, 07 §5.2) can live in a **passphrase-locked file** instead. Owner presence (§2.5) is unchanged. Where the owner's wrapped seed lives on these machines, and what that costs at rest, is specified below under "The owner key on a headless machine".

**Selection (never silent).**

1. **Keychain first.** At `init`, `@agentlink/node` probes the OS keychain: it writes, reads and deletes a probe item, with a timeout. If the probe succeeds, the keychain is used and the file KeyStore is refused. A probe that fails or times out explains how to fix the keychain, for example "unlock your keychain: `security unlock-keychain`" over SSH on macOS. **No forced file mode** (proposed; owner confirms at merge): there is no flag that picks the file KeyStore while a keychain works, because such a flag would be a downgrade path and a social-engineering line ("just run with `--force-file`"). If one is ever added, it is Advanced only, interactive, warned, recorded, flagged by `doctor`, and never part of copy the agent relays.
2. **No keychain, no opt-in → `needs_setup`** with a one-sentence explanation and the command to run (07 §9.4). This is the default.
3. **No keychain, explicit opt-in → file KeyStore.** The opt-in is `agentlink init --keystore file`, or a "yes" to the `init` question, in an interactive terminal. A run without a TTY (the agent-run `init` of 06 §7) never creates a file KeyStore; it returns `needs_setup`, so the passphrase does not pass through the agent's context in the normal flow.
4. **The choice is recorded per agent** (07 §9.1). A keychain that later appears or disappears never switches the backend, never falls back to the other one and never creates a new identity. A missing or unreadable keystore file is an error with a fix, not a reset.

**"Interactive only" is a UX guard, not a security boundary.** An agent with shell access can fake a terminal (`script`, `expect`, a pty library) and run the opt-in itself. Two further UX guards make that harder by accident, not impossible on purpose:
- the opt-in and the owner step are refused while known harness markers are set in the environment, for example `CLAUDECODE` and the Codex and Gemini CLI equivalents (list maintained in M1-8f);
- the user must re-type the last group of a generated code before anything is written.

An agent that drives the setup itself learns the agent unlock code. That costs nothing new, because it can read the agent key anyway (§2.2). If it also drives the **owner** step, it learns the owner secret, and owner presence on that machine is void. No software check on a same-user machine can prevent that. What still protects the owner:
- the owner doing the owner step personally, in a terminal the agent does not control, so the owner code is never shown to the agent;
- the passkey path (M1b), which needs the owner's physical gesture;
- the owner key living on the owner's own device and never on the headless machine (M2 default, below).

The spec claims nothing more.

**File format `ALKS` v1.** One file per agent, `~/.agentlink/keystore/<agentId>.alks`. `agentId` is the agent ID of §2.9 (`0x` + 40 lowercase hex). Before any path is built, it must match `[A-Za-z0-9_-]{1,64}` (the format's general rule, kept for future identifiers) and the exact §2.9 form, so a checksummed or upper-case spelling is refused.

```
magic       "ALKS"              4 B
version     u8 = 1
secretKind  u8                  1 = generated unlock code, 2 = chosen passphrase
kdf         u8 = 1              Argon2id v1.3 (RFC 9106)
m           u32be               memory in KiB
t           u8                  iterations
p           u8                  lanes
salt        16 B                random; new on create and on every passphrase change
aead        u8 = 1              AES-256-GCM
nonce       12 B                random; new on every write
idLen       u8                  1..64
agentId     idLen B             [A-Za-z0-9_-]
ct          ciphertext || 16-byte tag
```

- `kek = HKDF-SHA256(ikm = Argon2id(password(secret, secretKind), salt, m, t, p, L = 32), salt = "", info = utf8("agentlink/v1/keystore-file"), L = 32)`. Argon2id is version 0x13, with no secret value (K) and no associated data (X); `salt` is the 16 header bytes.
- **`password(secret, secretKind)`** (proposed; owner confirms at merge). The same rule applies to `ALKS`, `ALKO` and the recovery code (§2.3):
  - **Both kinds.** A secret read from a file first loses exactly one trailing `\n` or `\r\n`. Prompt and environment input lose nothing.
  - **Kind 1, generated code.** The steps below run on the input in order:
    1. Refuse any byte outside ASCII.
    2. Remove every space (U+0020) and dash (U+002D).
    3. Convert to upper case (ASCII only).
    4. Map `0`, `1` and `8` to `O`, `I` and `B`.
    5. Require exactly 24 characters, all from the RFC 4648 base32 alphabet `A–Z2–7`. Anything else is refused before the KDF runs.
    6. Decode them to 15 bytes: 24 characters are exactly 120 bits, with no padding and no leftover bits.

    `password` is **those 15 bytes**, not the characters. Normalisation is fully specified above, so two spellings of one code always give the same bytes.
  - **Kind 2, chosen passphrase.**
    1. The input bytes are decoded as **fatal** UTF-8: an invalid sequence, an overlong form or a lone surrogate is refused, never replaced with U+FFFD. A replacement would map different inputs to the same password.
    2. A C0 or C1 control character (U+0000–U+001F, U+007F–U+009F) is refused.
    3. `password` is the UTF-8 bytes of the NFKC form. Nothing else changes, and spaces are kept.
- The owner passphrase wrap pins its own label, `agentlink/v1/owner-passphrase-wrap`, and its own magic, `ALKO` (M1-1f). The two blob types are therefore never interchangeable in either direction, and a test covers both directions. The `ALKO` layout is below.
- **AAD = every header byte** from `magic` through `agentId`. A changed parameter, secret kind, salt, nonce or agent ID, a truncated file or a changed ciphertext all fail authentication.
- **Expected agent ID.** Before the KDF runs, the reader refuses a file whose header `agentId` differs from the agent being opened, that is, the file name and the recorded config. After decryption, the `seed` entry must derive the expected agent ID: its `agentlink/v1/evm` key at epoch 0 must have that address, compared as bytes (§2.9). A file copied over another agent's file therefore fails **even when both agents use the same passphrase**.
- **Plaintext:** a list of entries `u16be nameLen | name (UTF-8) | u32be valueLen | value`, one per keychain item that the keychain backend would hold for this agent. Names are the keychain account suffixes, for example `seed`, `store-key`, `s3:<id>`. Duplicate names, length overflows, trailing bytes and plaintext above 64 KiB are refused. Values stay in `Uint8Array` and never become JS strings.
- **Generated unlock code:** 15 CSPRNG bytes, exactly 120 bits, encoded as 24 RFC 4648 base32 characters with no bias, shown in groups of four. Input follows `password` kind 1 above.
- **Chosen passphrase:** follows `password` kind 2 above. The header's `secretKind` tells the reader which rule to apply.
- All of this runs through `@agentlink/crypto` (Argon2id and HKDF from `@noble/hashes`, AES-256-GCM via WebCrypto or `@noble/ciphers`) and the `KeyStore` interface (§8.1). `@agentlink/node` handles only files and never calls a primitive itself.

**Owner wrap format `ALKO` v1** (proposed; owner confirms at merge). It mirrors `ALKS`. It is used for the owner seed wrapped under an owner code or passphrase, both as the file `owner.alko` and as the keychain value on machines with a keychain (§2.2). The passkey PRF wrap (§2.3, M1-1k) is a different format.

```
magic       "ALKO"              4 B
version     u8 = 1
secretKind  u8                  1 = generated owner code, 2 = chosen owner passphrase
kdf         u8 = 1              Argon2id v1.3 (RFC 9106)
m           u32be               memory in KiB
t           u8                  iterations
p           u8                  lanes
salt        16 B                random; new on create and on every re-wrap
aead        u8 = 1              AES-256-GCM
nonce       12 B                random; new on every write
ct          ciphertext || 16-byte tag
```

- `kek = HKDF-SHA256(ikm = Argon2id(password(secret, secretKind), salt, m, t, p, L = 32), salt = "", info = utf8("agentlink/v1/owner-passphrase-wrap"), L = 32)`. `password` and the Argon2id settings are as for `ALKS`, and the KDF defaults, floor and cap are the `ALKS` values below.
- **AAD = every header byte** from `magic` through `nonce`. There is no `agentId`, because one owner can own several agents.
- **Plaintext** is exactly the owner seed: 32 bytes. The blob is therefore exactly 90 bytes (42 header, 32 seed, 16 tag). Any other size is refused before the KDF runs.
- **Expected owner.** After decryption, the seed must derive the owner keys named in the card of the agent being served (`ownerNostr` and `ownerEvm`). Otherwise the seed is wiped and the file refused.
- On file-KeyStore machines, `secretKind` must be 1. A kind 2 file is refused there before the KDF runs (below).
- M1-1h carries `ALKO` v1 vectors for both kinds, plus the cross-type cases: an `ALKO` blob under the `ALKS` label, and the reverse, both fail.

**KDF choice and parameters.** The KDF is Argon2id because the spec already uses it for the owner passphrase and the recovery code (§2.3, M1-1f). That means one implementation, one vector suite and one review instead of two. Argon2id is memory-hard, resists side-channel attacks and is standardised (RFC 9106). scrypt (`@noble/hashes`, N = 2^17, r = 8, p = 1) was the alternative; it was rejected only for this consistency.

| | Value | Reason |
|---|---|---|
| Default for new files | m = 64 MiB, t = 3, p = 1 | The same as the owner passphrase wrap. This meets RFC 9106's second recommended set; p = 1 instead of 4 does not lower an attacker's cost per guess |
| Target (proposed; owner confirms at merge) | Unlock ≤ 2 s expected and **≤ 5 s accepted** on a 2-vCPU container with a 512 MiB memory limit (Node LTS) | Unlock runs once per server start and **asynchronously** (`argon2idAsync` or a worker thread), after the MCP `initialize` answer. Until it finishes, tools return `needs_setup` (`keystore_locked`, "unlocking") |
| Above 5 s | Owner decision. Options in order: Node's built-in `crypto.argon2` behind `@agentlink/crypto`, with vector parity against `@noble`; then t = 2 at 64 MiB; never below the floor | Node's built-in is not an allowlisted dependency (AGENTS.md), so it is **not adopted**; it stays an open owner question. For generated 120-bit codes the KDF cost does not matter |
| Floor and cap on read | Refuse before the KDF runs if m < 19 MiB, t < 2, m > 256 MiB, t > 8, p < 1 or p > 4 | The floor is the OWASP minimum (m = 19 MiB, t = 2) and exists only for a future change of default. The cap stops a planted header from exhausting the reference container's memory or CPU |
| Runtimes | Node only | Browsers use the passkey PRF (§2.3) and Workers use Worker secrets (§2.2), so neither has a file KeyStore. Argon2id timing in browsers and Workers belongs to M1-1f |

**Passphrase strength.**
- **Agent:** the default is a generated unlock code; offline guessing of a stolen file is then infeasible. A passphrase the user chooses is allowed at the interactive prompt only. It must have at least 12 Unicode code points, counted after NFKC, and comes with a warning that a weak passphrase can be guessed if the file leaks.
- **Agent and owner secrets always differ, checked in both directions.**
  - Setting or changing the agent passphrase refuses a candidate that unlocks the owner's wrapped seed. The candidate is normalised the way the owner wrap normalises it (M1-1f). A candidate that fails a kind's normalisation (for example, it is not a valid generated code) counts as "does not unlock" for that kind, never as an error.
  - Creating or changing the owner secret on a machine with file KeyStores refuses a candidate that opens any of them, for every agent on the machine.
  - Any seed the check unwraps is wiped at once and never used.

  The agent passphrase often sits where the agent can read it, so reuse would hand over the owner key.

**Unlocking the agent key.** The harness starts the MCP server over stdio, so the server has no terminal to prompt in. It reads the passphrase from one of these sources, in this order (07 §9.2):

1. **Passphrase file** (`AGENTLINK_KEYSTORE_PASSPHRASE_FILE=<path>`). Recommended. It points to a secret mounted at run time, outside the persisted home directory and the image: Docker or Kubernetes secrets, a tmpfs mount, or a file provisioned from the host's secret store. It is opened with `O_RDONLY | O_NOFOLLOW` after `realpath`, and checked with `fstat` on the descriptor: a regular file, at most 1 KiB, not writable by group or others. A file readable by group or others is accepted with a `doctor` warning, because container secret mounts are often mode 0444.
2. **Environment variable** (`AGENTLINK_KEYSTORE_PASSPHRASE`). Allowed, because Codespaces and CI secrets arrive as environment variables, and documented as weaker (proposed; owner confirms at merge). Conditions:
   - `init` and the harness config writers only ever write the `_FILE` variable, never the value.
   - `doctor` warns whenever the value variable is set.
   - The server deletes **both** variables from `process.env` after reading, whichever source it used.
   - What deleting does **not** protect, stated in the quickstart:
     - `/proc/<pid>/environ` keeps the initial environment, readable by the same user and root while the process runs;
     - the parent chain (the harness, `npx`/npm, the shell);
     - `docker inspect` and container configs;
     - MCP config files;
     - shells started from a profile that exports the variable, where the agent's own `env` would print it into a transcript sent to the model provider.
   - Deleting only stops child processes started later from inheriting it. JS strings cannot be wiped.
3. **Interactive prompt** for CLI commands run in a terminal (`agentlink doctor`). Input is read as bytes without echo. **No CLI argument ever takes the agent passphrase**, because `argv` is visible to every user through `ps`.

The server derives `kek` and keeps only `kek`, together with the `salt`, `m`, `t` and `p` it was derived from, in memory while it runs. It decrypts entries for each operation, uses them and wipes them, matching the keychain backend's "in memory only as long as needed". With no source available, tools return `needs_setup` (`keystore_locked`) and name the fix without revealing anything about the file.

**The owner key on a headless machine.**

- **Never unlocked non-interactively.** `OwnerKeyStore` reads the owner secret only from an interactive prompt (M1-8c) or uses a passkey (M1-8e). No environment variable, file, argument, stdin pipe or MCP tool can supply it. An `AGENTLINK_OWNER_*` variable has no effect, and `doctor` warns that it is set and ignored.
- **Where it lives.** On a machine whose agents use the file KeyStore, the owner's wrapped seed is the file `~/.agentlink/keystore/owner.alko`, in the M1-1f format (magic `ALKO`). It follows the same file-handling rules as `.alks` files. It is never stored in plaintext and never inside an `.alks` file.
- **Offline-guessing exposure.** Every copy of the home directory, volume, image layer or backup carries `owner.alko`. A weak, human-chosen owner passphrase could then be guessed offline. So **on file-KeyStore machines the owner secret must be a generated 120-bit owner code** (the same encoding as the unlock code); a chosen owner passphrase is refused there. With 120 bits, guessing a copied `owner.alko` is infeasible, whatever the KDF cost.
- **Separate step.** `init --keystore file` creates only the agent identity. The owner key is created in a separate step, `agentlink owner init` †, in an interactive terminal. Its copy tells the user to run it themselves and never to let their AI run it or see the code. Until it is done, tools return `needs_setup` (`owner_missing`).
- **`owner init` rules:**
  - **It never overwrites.** It refuses when `owner.alko` already exists or when the agent's card already names an owner. Replacing an owner key is owner-key rotation (§2.6, P2) and out of scope.
  - **An existing owner is linked or restored, not re-created.** Linking an owner whose key lives on another device happens from that device (owner link, M2). Restoring one happens from the recovery kit (M1b), and the seed is then re-wrapped under a new generated owner code. `owner init` never creates a second, unrelated owner identity, which would show contacts a different owner fingerprint.
  - **The code is display-only.** `owner init` only displays the owner code. It never writes the code to a file, offers to, or stores it anywhere on the machine. The code-file offer of 07 §9.3 applies to the agent unlock code only.
  - **The owner can check the result.** `owner init` shows the short owner fingerprint (11 §5.2). `doctor` shows the fingerprint and when the owner key was created, so the owner can tell whether the key on the machine is the one they created. The quickstart says: "If you never saw an owner code yourself, this owner key isn't yours: replace the agent."
- **A lost owner code.** If the owner code is lost, this owner key can no longer approve, change rules, export (`backup export` †) or revoke the agent. Owner-key rotation is P2 (§2.6).
  - **M1a:** there is no recovery path. The user sets up a new owner and a new agent and pairs again with their contacts. The old agent cannot be revoked, so its credits should be kept small (§2.5).
  - **From M1b:** the owner restores from the recovery kit (§2.3, M1-9h/M1-9i).
  - `owner init` tells the user this before showing the code (07 §9.4).
- **`doctor`** warns while an owner key is present on a file-KeyStore machine and points to the off-device setup.
- **Owner operations from a headless machine:**
  - **M1a:** the owner runs `agentlink approve <id>` (or another † command) in a terminal the agent does not control, such as an SSH session or `docker exec -it`, and types the owner code there. Until the local approval server lands, `pending_approval` results name that command as `nextStep` (06 §2.5, M1-9c).
  - **M1b:** the local approval server also works through port forwarding (`ssh -L`, or devcontainer port forwarding), with the localhost passkey in the owner's own browser. The shared-`localhost` weakness of §2.5 applies unchanged.
  - **M2 default for file-KeyStore machines** (proposed; owner confirms at merge): the owner key lives on the owner's own device (the console or the desktop app), **not on the headless machine**. The owner approves there; the console sends an owner-signed `approval` or `policy` envelope (§2.5), and the core verifies it as usual. Keeping an owner key on the headless machine becomes an explicit opt-in.
- **G-1 applies unchanged, and it covers key creation too.** If the owner types the owner code on the same machine, as the same OS user as the agent, a tampered installation could capture it. During `owner init`, a tampered installation or a same-user process that reads memory (for example through ptrace, which Docker's default seccomp profile allows on kernel 4.8 and later) can also capture the owner seed and code, or fix them in advance. On machines where the agent has unrestricted shell access, the owner key therefore belongs on the owner's own device (the M2 default). A TTY shows presence, not intent.

**File handling** (`.alks` and `owner.alko`).

- **Permissions.** `~/.agentlink/keystore/` has mode 0700; files have mode 0600. Both are created with explicit modes that do not depend on the umask, and then checked.
- **Checks on every open:**
  - Files are opened with `O_RDONLY | O_NOFOLLOW` (and the directory with `O_DIRECTORY | O_NOFOLLOW`).
  - Every check runs with `fstat` on the open descriptor, not on the path: a regular file, owned by the process user, no group or other permission bit (as `ssh` requires for private keys), a size within limits.
  - `realpath(file)` must sit directly inside `realpath(~/.agentlink/keystore)`; both sides are resolved, because `$HOME` may itself be a symlink.
  - The error says how to fix the problem.
- **Filesystems without POSIX modes are refused.** At creation, the code `chmod`s the file, then runs `fstat` and checks that the mode stuck. This covers WSL DrvFs (`/mnt/c`) without `metadata`, 9p, SMB and FUSE mounts. The keystore must live on a filesystem with POSIX modes.
- **Writes.** A write is one of: create the file; add or remove an item (for example storage credentials, an owner operation per §2.5 that the CLI performs while the agent store is unlocked); change the passphrase. Every write runs in this order, under the agent's inter-process lock (07 §3, 06 §6):
  1. Re-read the file under the lock.
  2. Check that its header `salt`, `m`, `t`, `p` and `secretKind` equal those behind the in-memory `kek`.
  3. Decrypt the current contents.
  4. Apply the change.
  5. Write with a fresh nonce: a temporary file (`O_CREAT | O_EXCL | O_NOFOLLOW`, mode 0600) in the same directory, fsync it, rename it over the target, fsync the directory.

  If the header check fails, the write is aborted and nothing is written. The server then returns `needs_setup` (`keystore_locked`) until it is restarted. A server holding a stale `kek` can therefore neither revert a passphrase change nor drop items another process wrote. A crash leaves either the old file or the new one, both valid. Stale temporary files are deleted under the lock at start-up.
- **Changing the passphrase** (`agentlink keystore passphrase`):
  - It takes the same lock and requires the **current** passphrase typed at the prompt, never taken from the file or the variable. This stops a non-interactive lock-out.
  - It writes a fresh salt and re-runs the KDF.
  - Its copy states: "Changing the unlock code doesn't protect copies of the file made earlier (backups, image layers, snapshots). If the code or the file leaked, replace the agent."
- **Zeroisation (§8.3).**
  - `kek`, the Argon2id output, decrypted entries, and passphrase bytes from a file or prompt are `Uint8Array` buffers, filled with zeros after use and on exit.
  - Residuals: JS strings (the environment variable), the garbage collector's copies and the KDF's working memory cannot be wiped reliably. M1-8f checks whether `@noble/hashes` clears its Argon2id buffers and records the answer.
  - Core dumps can contain `kek`; the quickstart recommends disabling them in containers.
- **Logging and display (I-7).**
  - Nothing secret appears in any log, error, tool result, `doctor` output or CLI argument: no passphrase, unlock or owner code, `kek`, store key, storage secret, entry value, or file contents.
  - The redacting logger treats both environment variable names as secret-bearing.
  - The code pattern (24 base32 characters in groups) is added to the CI secret-pattern test (§8.4).
  - A generated code is shown once and the screen is cleared after the user confirms it, to limit scrollback and tmux logs. When the user asks for a code file, it is written with `O_CREAT | O_EXCL | O_NOFOLLOW` and mode 0600, never under `~/.agentlink`.

**Threat model delta (compared with the OS keychain).**

| | Keychain (§2.2 Local) | File KeyStore |
|---|---|---|
| Shell-capable agent, same OS user: agent key | Can read the agent seed (§2.2 rationale) | **No change.** Whatever the server can read to unlock, the agent can read too (the passphrase file, the environment, process memory) |
| Shell-capable agent, same OS user: owner key | Owner presence (§2.5); G-1 residual | Owner presence and I-4 hold as written, **if the owner does the owner step personally**. An agent that fakes a terminal and runs the owner step itself learns the owner code, and owner presence on that machine is void (above). Mitigations: a separate owner step, harness-marker and re-type guards (UX only), the passkey (M1b), the owner key off the machine (M2 default) |
| Copy of the home directory, volume, image layer, backup or dotfile sync | OS keychain storage, usually bound to the OS login | **Weaker.** The `.alks` file travels with copies and stays protected only if its passphrase source is not copied with it. With a generated code kept elsewhere, guessing is infeasible; with a weak chosen passphrase, it is not. The copy also carries `owner.alko`, which a required 120-bit owner code protects against offline guessing. Changing a passphrase does not protect earlier copies |
| Passphrase source stored on the same disk (for example in an MCP config) | — | **No at-rest protection for the agent key beyond disk encryption.** The quickstart and `doctor` say so |
| Other OS users on the machine | Keychain access control | File modes (0700/0600). Root can read both |
| Stolen machine or disk | OS login and disk encryption | The passphrase (if its source is not on the disk) and disk encryption |
| Forward secrecy (§6) | "Keychain storage" mitigation | Weaker at rest, as in the copy row. Key rotation and short file expiry are unchanged |

**What stays protected in every case:**
- Content and keys never leave the machine (I-1, I-2).
- Export and recovery work (I-10), through `backup export` (M1b) and the recovery kit. In M1a there is no backup command yet, so a lost unlock code means a new agent identity, and the copy says so (07 §9.4).
- The owner key and everything owner-signed (I-4) stay protected under the condition stated in the owner-key row above.

The user is told the trade-off once, in plain words, at opt-in, and `doctor` repeats it (07 §9.4).

**Required tests** (M1-8f, tests first):

- **Canary (I-7):** canary values for the passphrase, unlock code, owner code, seed, `kek`, store key and S3 secret never appear in logs (debug included), errors, tool results, `doctor` output, crash traces, the SQLite file or any file other than the `.alks`/`.alko` ciphertext. No CLI command accepts the agent passphrase as an argument. The CI secret-pattern test knows the code pattern.
- **Wrong passphrase:** one generic error and no partial output. "Wrong passphrase" and "tampered file" are indistinguishable in messages and exit codes.
- **Tamper detection:**
  - flipping any byte of the header (including `secretKind`), salt, nonce, ciphertext or tag fails;
  - a truncated file fails;
  - unknown `version`, `kdf`, `aead` or `secretKind` values are refused;
  - out-of-bounds KDF parameters are refused before the KDF runs.
- **Agent binding:** two agents with the **same** passphrase; swapping their files fails both before the KDF (header `agentId`) and after decryption (seed-derived ID). An `agentId` outside `[A-Za-z0-9_-]{1,64}`, or not in the exact §2.9 form (checksummed, upper-case, without `0x`, wrong length), is refused before any path is built.
- **Parser:** duplicate entry names, length overflow, trailing bytes, plaintext above 64 KiB, `idLen = 0` and an invalid `agentId` charset are all refused.
- **Normalisation:** a generated code is accepted in lower case, with spaces and dashes, and with `0`/`1`/`8`; a wrong length is refused before the KDF. A chosen passphrase is NFKC-normalised and its spaces are kept. There are vectors for both secret kinds (M1-1h).
- **Permissions:**
  - modes 0700/0600 under umask 000 and 077;
  - refusal for group or other bits, another owner, a symlinked directory or file, a `realpath` escape, a symlinked `$HOME` that still resolves inside (accepted), and a mode that does not stick (DrvFs, 9p);
  - the passphrase-file rules, checked with `fstat` on the descriptor.
- **Write protocol:**
  - with a server running, change the passphrase from the CLI: the server's next write fails closed, the new passphrase still opens the file, and no item is lost;
  - a simulated crash between write and rename leaves a valid file;
  - concurrent writers under the lock lose no update;
  - stale temporary files are removed at start-up.
- **Selection:**
  - keychain available → file KeyStore refused;
  - probe timeout → the fix message;
  - no keychain and no opt-in → `needs_setup`;
  - opt-in without a TTY → `needs_setup`;
  - opt-in with a harness marker set → refused;
  - the recorded backend never switches.
- **Owner key:**
  - no non-interactive source unlocks `OwnerKeyStore` (`AGENTLINK_OWNER_*`, a file, an argument, piped stdin);
  - on file-KeyStore machines, a chosen owner passphrase is refused and `init --keystore file` creates no owner key;
  - `owner init` refuses when `owner.alko` exists or the agent's card already names an owner, and never overwrites;
  - `owner init` writes the owner code to no file (a filesystem scan after setup finds no file containing it) and offers no code file;
  - `owner init` shows the owner fingerprint and the lost-code consequence before showing the code, and `doctor` shows the fingerprint and the creation time;
  - agent ≠ owner is enforced in both directions and across several agents, with matching normalisation;
  - the M1-8c same-user test passes on the file backend with the agent passphrase readable by the test script.
- **Environment:** both variables are removed from `process.env` after reading, and child processes started later do not inherit them. `init` never writes the value variable into a harness config.
- **Unlock timing:** the async unlock answers MCP `initialize` before the KDF finishes, and tools return `keystore_locked` until it does.
- **Vectors:** `ALKS` v1 vectors (fixed secret, kind, salt, nonce and entries) from M1-1h, checked in CI. The CI job on Ubuntu without D-Bus or Secret Service runs the file backend end to end.

### 2.9 Agent ID and fingerprints (G-23; proposed, owner confirms at merge)

**Definition.** `agentId` is the agent's EVM address: the last 20 bytes of `keccak256` over the uncompressed public key (without the `0x04` prefix) of the `agentlink/v1/evm` key at epoch 0 (§2.1). It is the same value as the card's `agentEvm`, the `agent` of a `SignedOwnerAction` (§2.5.1, D-58), the entries of `terms.parties` (§3.4), a commitment scope's `agentId` (§3.4.2) and a Record's `signer` (05 §3.1). There is one agent identifier, so `agentId` can never become a second binding.

- **Text form:** `0x` followed by 40 lowercase hex characters everywhere: JSON (§2.4.1), the keychain account (§2.2), `ALKS` file names and headers (§2.8) and configs. An EIP-55 checksummed form is for display only and is refused as input.
- **Why the address.** It is the only identity key that never rotates. The Nostr and encryption keys change with `keyEpoch` (§2.6), so an ID built from them, or a hash over both key families, would change on rotation, or would need a second, frozen derivation for the same identity. Credits, Records, Receipts, the Registry and owner actions are already tied to the address.

**Derivation and checks.** `agentId` is always computed from the agent seed, never chosen. `init` derives it and records it in the agent's local config, next to the local agent name (`--agent <name>`, 06 §6), and in the `identity` table (07 §3). Each backend checks it whenever the seed is loaded:
- the file KeyStore before the KDF (header) and after decryption (the `seed` entry must derive the header's `agentId`, §2.8);
- the keychain backend after reading the `seed` item under account `<agentId>`.

A mismatch is an error with a fix, never a new identity.

**Uniqueness.**
- **Global.** The address is 160 bits of a key from a 256-bit random seed. Honest agents collide with negligible probability. Matching a given agent's address costs about 2^160 work; a birthday search for any two equal addresses costs about 2^80 and only gives an attacker two agents of its own.
- **A claim needs the agent key.** The card is signed by the owner (§2.4), so an owner could otherwise put someone else's `agentEvm` in its own card. Two things stop that:
  - `cardAgentSig`: the invite and the `handshake` carry the agent EVM key's EIP-712 signature over the same `AgentCard`, under the same chain-agnostic domain. It is the signature the Registry calls `cardAgentSig` (05 §4), so one signature serves both. It is `0x` + 130 lowercase hex under the canonical ECDSA rule (§2.4.1). The receiver recovers the signer and requires it to equal `card.agentEvm`, compared as bytes. This shows that the agent key endorsed this owner binding. It does **not** show liveness: card and signatures are public and can be replayed.
  - **Liveness** comes from the messages themselves. A `handshake` is accepted only from `card.agentNostr` (envelope `from` and seal key, §3.6), over a body that names `inviteId`, `nonceB` and the inviter (`inviterCardHash`). A pairing that starts from an invite completes only on a `handshake-ack` from the invite card's `agentNostr` (§3.4.1). A replayed card therefore completes nothing.
  - A `card-update` needs neither, because `agentEvm` cannot change in it (§3.4.1). A card whose `agentEvm` equals its `ownerEvm` is refused, because owner and agent signatures would then coincide.
- **Per store.** A store holds at most one contact per `agentId`, and never its own `agentId` as a contact. The contact `id` in tool results and CLI commands (06 §2.1, `agentlink contacts --verify <id>`) is the contact's `agentId`. Its privacy cost is small: the address already appears in `terms.parties` and Records, and the drop key stays unlinkable (D-48).
- **Re-pair.** A pairing for an `agentId` that is already a contact is a re-pair. It is allowed when `ownerEvm`, `ownerNostr` and `ownerEnc` are unchanged and `keyEpoch` is not lower. Otherwise, and always for a revoked `agentId` (§3.4.1), it is refused and shown in the activity feed.
  - **Nothing changes until it completes:** for A, when it accepts the `handshake` (§3.6); for B, when the `handshake-ack` verifies. Until then the existing contact, its card, its pairing and its "Safety code checked" state stay as they are. A pairing that never completes (an unanswered or replayed invite, a missing ack) changes nothing and lapses with the invite's expiry.
  - On completion the stored card and pairing are replaced, and the new pairing has a new safety code (§3.6.1).
  - **Concurrent pairings** between the same two agents (for example, crossed invites) can both complete. Each side then keeps the completed pairing whose `handshake` has the later `createdAt`, with ties broken by the larger `envelopeHash` compared as bytes. Both sides hold both handshakes, so they choose the same pairing. If one side never completed the other pairing, the owners see different codes and pair again.

**Storage object keys.** Objects in the owner's storage (07 §5.2) are keyed `agentlink/<storagePrefix>/<random 128-bit>`, never by `agentId`. `storagePrefix` is 16 random bytes (base64url), generated at `init`, recorded in the agent's config and the `identity` table, and not derived from any key. A presigned URL therefore never carries the agent's address, which links to its Records and credits. The prefix still lets one bucket serve several agents with prefix-scoped credentials. It does not hide that two links point into the same bucket; the URL's host shows that anyway.

**Fingerprints (display only).**
- **Owner fingerprint** = `taggedHash("agentlink/owner-fingerprint/v1", ownerEvm ‖ ownerNostr ‖ ownerEnc)` over the raw 20, 32 and 32 bytes from the card. It covers `ownerEvm`, the key that signs cards, so a card that copies another owner's `ownerNostr` does not get that owner's fingerprint.
- **Agent fingerprint** = `taggedHash("agentlink/agent-fingerprint/v1", agentId)` over the raw 20 bytes. Advanced only (11 §5.2).
- **Short form** (default views; the "Contact" fallback of 06 §2.1): the first 4 bytes as 8 upper-case hex digits in two groups joined by `·` (U+00B7), e.g. `7F3A·19C2`. **Long form** (Advanced): all 32 bytes as 64 hex digits. The domain claim's `fp` (§2.7) is the long owner fingerprint in lower case.
- **Identify, not authenticate.** 32 bits only tell contacts apart. Matching a chosen short fingerprint costs about 2^32 hashes, seconds on one GPU, because an attacker may vary any key in its own card. Only the safety code (§3.6.1), a Registry registration and a verified domain authenticate. When two entries in one store share a short fingerprint but differ in the long one, both are shown with the first 8 bytes (`7F3A·19C2·5D0E·88B1`), and the activity feed flags the newer one.
- Fingerprints are display strings, not protocol values: no input field accepts them, and §2.4.1 does not apply to them.

---

## 3. Envelope (message container)

### 3.1 Structure (v1)

All binary values are base64url **without padding** in JSON unless §2.4.1 puts them in a hex class.

```jsonc
{
  "v": 1,
  "id": "<16 random bytes>",
  "thread": "<16 bytes, stable per conversation>",
  "from": "<sender nostr x-only pubkey, 64 lowercase hex>",  // the sending agent; the owner on the owner channel (§3.4.1)
  "createdAt": 1760000000,
  "recipients": [
    { "kid": "<first 16 bytes of sha256(raw 32-byte encPub)>",
      "enc": "<HPKE encapsulated key>",
      "wk":  "<HPKE ciphertext of the CEK>" }
  ],
  "aead": { "alg": "A256GCM", "iv": "<12 bytes>", "ct": "<ciphertext || 16-byte tag>" },
  "sig": "<BIP-340 signature, 128 lowercase hex>"
}
```

- `envelopeHash = sha256(JCS(envelope without "sig"))` (RFC 8785). This is the value notarized on-chain.
- AEAD additional data = `sha256(JCS({v, id, thread, from, createdAt, recipients}))`.
- `sig` = BIP-340 Schnorr by `from` over `taggedHash("agentlink/envelope/v1", envelopeHash)` (BIP-340 tagged hash), so envelope signatures can never be confused with Nostr event signatures. Exact bytes, keys, verification and size limits: §3.1.1.

#### 3.1.1 Envelope signatures, keys and limits (G-2; proposed, owner confirms at merge)

**What is signed.** One construction for every envelope and every sender:
1. `E` is the strictly parsed envelope (M1-1c) with every key except `sig`: `v`, `id`, `thread`, `from`, `createdAt`, `recipients` (in the order sent) and `aead` (`alg`, `iv`, `ct`). The hash is computed from the parsed copy, so what is hashed is what was checked.
2. `envelopeHash = sha256(JCS(E))`, 32 bytes.
3. `m = taggedHash("agentlink/envelope/v1", envelopeHash) = sha256(sha256(t) ‖ sha256(t) ‖ envelopeHash)`. `t` is the 21 UTF-8 bytes of the tag, and `envelopeHash` enters as its 32 raw bytes, never as hex.
4. `sig = BIP-340 Sign(sk, m, auxRand)`, with 32 fresh CSPRNG bytes as `auxRand` (vectors fix them). `sk` is the secret key of `from` (table below). `sig` is the 64-byte signature as 128 lowercase hex (§2.4.1).

The AAD (§3.1) covers the header only. The hash also covers `aead`, so the signature commits to the ciphertext. It does not commit to the plaintext, because AES-GCM is not key-committing (G-46).

**Domain separation.** A Nostr key signs several kinds of object. Each has its own 32-byte message:

| Object | Message that BIP-340 signs | Key |
|---|---|---|
| Envelope `sig` (this section) | `taggedHash("agentlink/envelope/v1", envelopeHash)` | agent or owner Nostr key |
| `SignedOwnerAction` `sig` (§2.5.1) | `taggedHash("agentlink/owner-action/v1", sha256(JCS(OwnerAction)))` | owner Nostr key |
| Nostr events: seal (kind 13), NIP-42 AUTH (kind 22242) | the NIP-01 event id: `sha256` of the JSON text `[0,"<pubkey>",…]` | agent or owner Nostr key |
| Drop requests (§4, 07 §5.4) | as fixed there | drop key only |

- The two tagged messages start with different 64-byte prefixes, and a NIP-01 id hashes a JSON text that starts with `[0,"`. A signature valid for one object is valid for another only through a SHA-256 collision. The owner-action tag and the envelope tag are never interchangeable, even over the same 32 bytes.
- **Rule.** A new BIP-340 use of an agent or owner Nostr key gets its own tag `agentlink/<name>/v1` and a row in this table. No key signs a raw, untagged digest. A verifier checks a signature only under the tag of the object it verifies.
- The EVM key (ECDSA, EIP-712) never signs an envelope, and the drop key signs only drop requests.

**Which key signs.**

| Envelope types | `from` and signing key | Signed through |
|---|---|---|
| Every type an agent sends: the 02 F-22 types, `handshake`, `handshake-ack`, `card-update`, `proof`, `ack`, `approval-request` and the `policy` echo | The agent's Nostr key at its current `keyEpoch` (§2.6) | `KeyStore.signEnvelopeHash` |
| `approval`, `policy` (owner → agent) and `revoke` (§3.4.1) | The owner's Nostr key (epoch 0; owner-key rotation is P2, §2.6) | `OwnerSession.signEnvelopeHash`, in a session from `OwnerKeyStore.unlock(presence)` (§2.5) |

- **Owner signing.** The owner key signs an envelope only for those three types, only in a session opened with presence, and in the same gesture as the `SignedOwnerAction` it carries. Its seal (kind 13) is signed by the same session, because §3.5 requires the seal key to equal `from`.
- **The owner's envelope signature authorises nothing.** It lets the receiver attribute the envelope to the owner key. Authority comes only from the carried `SignedOwnerAction` (§2.5, §3.4.1).
- **Receivers enforce the table.** `approval` and `policy` are accepted only from the agent's own owner key (§3.4.1). `revoke` follows §3.4.1: authority comes from the carried object, whatever the `from`. Any other type whose `from` is the agent's own owner key, or the `ownerNostr` of a contact's card, is dropped.

**Key interfaces (G-2).**
- **Location.** `KeyStore`, `OwnerKeyStore`, `OwnerSession` and the shared `EnvelopeKeys` interface are types in `@agentlink/crypto`'s main entry, so `transport-nostr` and `core` both use them without a dependency cycle (03 §3, 07 §1). The implementations that hold a seed live in the restricted subpath `@agentlink/crypto/keystore` and in `@agentlink/node` (keychain and file backends). Test doubles (`MemoryKeyStore`, `MemoryOwnerKeyStore`) are in an entry point that deps-check allows only in tests, `test-vectors` and e2e, never in production `src` (IR-M1-1g-1 M-2). The self-host Worker gets its own backend (M2-3a), not the test double.
- **`EnvelopeKeys`** is the set of methods that build and open envelopes. `KeyStore` (the agent's keys) and `OwnerSession` (the owner's keys) both implement it, so the transport and core paths are the same for both:
  - `signEnvelopeHash(envelopeHash)`: takes the 32-byte `envelopeHash` and returns `sig`. It applies the tag itself, so no method signs an untagged digest. Hash-in gives the holder nothing new: the agent key signs every envelope anyway, and a session can sign any owner action. The caller computes the hash from the parsed envelope with M1-1c's `envelopeHash`.
  - `signNostr(event)`: seals and NIP-42 AUTH. On an `OwnerSession`, only kinds 13 and 22242 are signed, and any other kind is refused. A session is a bearer handle (IR-M1-1g-1 I-5), and a general owner signer could replace the owner-backup event (§2.3). That event gets its own method when G-36 is resolved.
  - `nip44Encrypt(peer, plaintext)` and `nip44Decrypt(peer, payload, {epoch?})`.
  - `unwrapCek(wrapped, envelopeId, {epoch?})`: opens one recipient entry and returns the 32-byte CEK, which the caller wipes after the payload AEAD. It builds `info = "agentlink/v1/cek" ‖ id` itself from the 16-byte envelope id. This replaces `hpkeOpen(wrapped, info)`, so a KeyStore is never a general HPKE-open oracle for other contexts (IR-M1-1c-1 F5).
- **`KeyStore`** adds `getPublicBundle({epoch?})` (public keys and `kid` at that epoch) and `sign712`. **`OwnerSession`** adds `signOwnerAction` and `sign712`.
- **Epochs.** Signing and encryption always use the current epoch. `{epoch}` exists only on the decrypting methods and on the public-key lookup. An epoch above the current one is refused (`epoch_unavailable`). An `OwnerSession` has epoch 0 only.
- **Owner sessions.** A production surface collects presence itself, from the owner's own input: an interactive terminal prompt, a WebAuthn ceremony or the native approval window. It never takes presence from an environment variable, a file, a command-line argument or a tool input (§2.5, §2.8, D-54). A session is never handed to MCP-reachable or agent-reachable code. Its expiry is enforced on a monotonic clock, and `lock()` also stops an `unlock` that is still in flight (IR-M1-1g-1 I-4, I-5, L-1, L-2).

**Recipient entries (sender, core).**
- The sender writes exactly the set of §3.2, or of §3.4.1 for the owner channel, with **one entry per distinct `enc` key**. When both agents have the same owner, that owner has a single entry. Gift wraps follow the same rule: one per distinct Nostr key (§3.5).
- The order of the entries is the sender's choice. The hash and the AAD cover it, and receivers compare the entries as a set.

**The owner reads its envelopes (I-9).** The owner is a recipient of its agents' envelopes (§3.2 entries 2 and 3) and of the owner channel (§3.4.1). It also reads back its own `approval`, `policy` and `revoke` on another device. Senders take `ownerEnc` (the CEK wrap) and `ownerNostr` (the gift wrap) from the cards. All steps run inside one `OwnerSession`:
1. `nip44Decrypt` of the gift wrap (from its ephemeral key) under the owner Nostr key gives the seal. The seal's signature is verified, and `nip44Decrypt` of its content (from the seal key) gives the rumor.
2. The envelope is checked as in the verification rules below, steps 1–4.
3. The core finds the one entry whose `kid` is the `kid` of `ownerEnc`.
4. `unwrapCek(entry, id)` gives the CEK. The payload is decrypted with the AAD (§3.1), and the CEK is wiped.

- **Reading needs presence.** The gift wrap is addressed to `ownerNostr`, the key that signs owner actions, so no read-only owner key exists. A read session gets the same protections as a signing session. Receiving owner copies from DM relays also needs NIP-42 AUTH with the owner key (kind 22242) in the same session. How long the console keeps a read session open is decided in M2-2d, and it never outlives the console's own unlock. A separate owner inbox key would need a new card field and is not proposed.
- A surface may keep the plaintext it read under its own at-rest rules (07 §3, 08). It never keeps the owner keys.
- An agent's `KeyStore` never holds owner keys and never opens an owner entry.

**Verification (fail closed).** Inbound envelopes are checked in this order. A failure at any step drops the envelope, with nothing processed in part. Errors never echo the input (I-7).
1. **Size before parsing** (transport): the limits below.
2. **Transport** (§3.5, M1-5a): the gift wrap and seal signatures verify, the rumor key equals the seal key, the seal key equals `from` (as bytes), and the `agentlink` tag is present.
3. **Strict parse** (M1-1c): exact keys and encodings (§2.4.1); 1 to 8 recipients with distinct `kid`s; the `ct` limit.
4. **Signature.** `from` lifts to a curve point (BIP-340 `lift_x`), and `sig` verifies under `from` over `m` above. Only the envelope tag is tried. An untagged `envelopeHash` and a NIP-01 check are never accepted.
5. **Own entry.** The core looks for an entry whose `kid` matches one of its own `enc` keys, at any epoch (`getPublicBundle({epoch})`). With none, the envelope is not for this agent. With one, there is exactly one `unwrapCek`, at that entry's epoch, so an envelope never makes the core try more than one HPKE open per local key. A failed open or AEAD is dropped (`open_failed`).
6. **Payload.** The payload passes its strict schema (`@agentlink/types`, M1-2a; `terms` limits M1-21).
7. **Sender role.** `from` must be the key that the type requires:
   - a contact's agent key: the `agentNostr` of the contact's **current** card. A superseded epoch key is refused, except for `card-update` (§3.4.1), so a key replaced after a compromise cannot keep sending. The refused envelope is stored as refused and shown in the activity feed, never in `agentlink_inbox`. Owner copies stay readable.
   - pairing types: as §3.6 and §3.4.1 state;
   - owner types: as the table above;
   - an unknown agent key goes to the requests queue (06), and only after steps 1–6.
8. **Own owner (I-9).** The recipients must include the `kid` of the agent's own owner's `ownerEnc`. Without it, the envelope is stored as refused and shown in the activity feed, because the agent's owner could not read it. The check shows that an entry is present, not that it opens.
9. **Freshness and uniqueness.** A `createdAt` more than 300 s in the future (`S`, §2.5.1) is refused. An `id` already stored with a different `envelopeHash` is refused, and the contact is flagged in the activity feed.

Decrypting stored history with an older epoch key stays allowed (§2.6). Only accepting a new envelope from a superseded sender key is refused.

**Size limits and where each one is enforced.** "24 KB" in §3.5 and 07 §4.2 means 24 576 bytes.

| Limit | Value | Enforced in | Why |
|---|---|---|---|
| Inbound relay frame | ≤ 131 072 bytes (128 KiB), checked on the raw WebSocket message **before** `JSON.parse` | `transport-nostr` (M1-5b) | The largest valid gift wrap (NIP-44 payload at its maximum of 87 472 characters) is about 88 KB as an `EVENT` frame. The 128 KiB proposed in IR-M1-1c-1 F3 fits here, at the outermost layer |
| NIP-44 payload | 132 to 87 472 characters, plaintext ≤ 65 535 bytes | `@agentlink/crypto` (M1-1g) | NIP-44 v2 |
| Envelope (rumor `content`) | ≤ 24 576 bytes of UTF-8, checked on the string **before** `JSON.parse`. On send: the JCS envelope is checked before wrapping | `transport-nostr` (M1-5a), on both send and receive | §3.5. At this size the worst-case seal is 38 663 bytes (under the NIP-44 limit) and the `EVENT` frame is 55 131 bytes (under the common 64 KiB relay cap) |
| `recipients` | 1 to 8 entries, distinct `kid`s | `@agentlink/crypto` parser (M1-1c), so every caller gets it | §3.2 needs at most 5 (with the P2 arbitrator), and the owner channel needs 2. 8 leaves room for one more role without a new version. It also caps the publish fan-out (one gift wrap per key) and the parse work, at about 157 bytes per entry |
| `aead.ct` | 16 to 17 152 bytes decoded, so the payload plaintext is ≤ 17 136 bytes. Checked on the base64url length (≤ 22 870 characters) **before** decoding | `@agentlink/crypto` parser (M1-1c) | The largest multiple of 64 that keeps the worst-case envelope (8 entries, `createdAt` = 2^53 − 1) at or under 24 576 bytes as JCS (24 509 bytes). So every envelope that passes the parser fits §3.5 |
| Exact recipient set; one HPKE open | per type (§3.2, §3.4.1) | `core` (M1-7b) | I-9, and bounded work per envelope |
| Payload fields | payload schema (M1-2a), `terms` limits (M1-21), inline files per G-27 | `core` and `@agentlink/types` | |

- **The IR-M1-1c-1 F3 values were checked and not adopted for `ct`.** A `ct` of 64 KiB + 16 gives an envelope of about 89 KB, above the 65 535-byte NIP-44 plaintext limit of the seal, so it could never be sent. D-48 sends files through the encrypted drop or the owner's storage, not inline, so the inline payload can stay small. The 1–8 recipient cap and a raw cap before `JSON.parse` are adopted, the second at both layers above.
- A 12 KB inline file (16 384 base64url characters) still fits, with about 750 bytes left for the rest of the payload. G-27 ("inline only if the final envelope ≤ 24 KB") decides.
- Raising a limit means older receivers refuse the larger envelopes. It is a spec change with a compatibility note, never a silent default change.

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
      "plaintextSha256": "<64 lowercase hex>", // proves 'document matches' later
      "ciphertextSha256": "<64 lowercase hex>",// integrity before decrypt
      "inline": "base64url (≤ 12 KB) | null",
      "url": "download URL (presigned, drop or share link) | null",
      "fileKey": "base64url(32)",
      "expiresAt": 1760000000 } ]
}
```

- **`proof` type** (body `{envelopeId, chainId, recordId, salt}`) is sent **after** a record is submitted, as a follow-up envelope. `envelopeId` is the notarized envelope's `id` (base64url), `chainId` a JSON integer, and `recordId` and `salt` are `bytes32` values, each `0x` + 64 lowercase hex (EVM-native, §2.4.1), spelled exactly as in the proof pack (07 §8). This works both for "send with proof" and for notarizing an older envelope; a notarized envelope itself never claims proof.
- **`approval-request` / `approval` / `policy` / `revoke` / `card-update` / `handshake-ack`** bodies are fixed in §3.4.1.
- **`offer` / `accept` / `reject` carry `terms`** (D-32), so agents can negotiate and agree on exact terms:

```jsonc
// body of offer / accept / reject
{
  "terms": {
    "termsId": "<16 random bytes>",              // stable for one negotiation; scoped to the two parties
    "version": 3,                                 // newest version + 1, set by the sender's core
    "parties": ["0x<agent A>", "0x<agent B>"],    // agent IDs = stable agent EVM addresses (§2.1), 0x + 40 lowercase hex (§2.5.1); two parties in beta
    "subject": "Spec v2 – milestone 3",
    "deliverables": [ { "id": "d1", "description": "…", "by": "0x<agent B>", "plaintextSha256": "<64 lowercase hex> | null" } ],  // by = the party that delivers
    "price": { "amount": "1500.00", "currency": "EUR", "payer": "0x<agent A>" },   // optional; payer = the party that pays
    "deadlines": [ { "ref": "d1", "due": "2026-11-30T17:00:00Z" } ],
    "validUntil": 1760600000,                     // unix seconds; the terms lapse after this
    "previousTermsHash": "<64 lowercase hex> | null" // termsHash of the version this one replaces
  },
  "termsHash": "<64 lowercase hex>",              // sha256(JCS(terms)), RFC 8785; bare hex (§2.4.1)
  "note": "string | null"                         // free text, not covered by termsHash; only on reject and on unrecorded offers (never on accept or a firm offer)
}
```

  - `termsHash = sha256(JCS(terms))`. The core recomputes it on send and on receipt and refuses a mismatch.
  - **Canonical form (D-55).** The core refuses, on send and on receipt, terms that are not already canonical, so what the owner sees is exactly what is hashed:
    - every string is Unicode NFC and contains no C0 or C1 control, no bidi control (U+200E, U+200F, U+202A–U+202E, U+2066–U+2069), no other format character (category Cf, zero-width characters included) and no private-use code point;
    - `price.amount` matches `^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$` and is greater than zero;
    - `price.currency` matches `^[A-Z]{3}$` (ISO 4217) or is exactly one of the allowlisted token symbols;
    - `price.payer` and every `deliverables[].by` are one of the two `parties`, and `deliverables` ids are unique;
    - `deadlines[].due` is strict RFC 3339 in UTC (`YYYY-MM-DDTHH:MM:SSZ`), `validUntil` is an integer, `plaintextSha256` is 64 lower-case hex digits (§2.4.1), and size limits follow M1-21.
    Displays derive from these stored bytes: amounts and dates are formatted from the canonical values, and text is shown as stored.
  - `offer` carries proposed terms. `accept` and `reject` carry the terms they answer (so a notarized `accept` is self-contained) and **must quote their `termsHash`**. The core refuses to send an `accept` unless the hash matches an `offer` received from that contact in the thread, that offer is the newest version of its negotiation (same `termsId`) in the store, the terms are within `validUntil`, and `parties` are exactly the sender and the recipient. Agents never supply the terms of an `accept` or `reject`: the core copies them from the stored offer (06 §2.2a, D-55). **Negotiation chain (D-55).** A negotiation is keyed by `termsId` plus the unordered pair of `parties`, so a `termsId` from one pair never affects another. Each core computes the chain from its own store and never trusts the counterparty's pointer. A sending core sets `version` to the newest version it holds plus one and `previousTermsHash` to that version's `termsHash` (`null` and 1 for a new negotiation). A receiving core accepts an `offer` only when `version` is its newest plus one and `previousTermsHash` equals its newest `termsHash`; otherwise it stores the envelope as refused and shows it in the activity feed. **No forks**, and no tie-break that a sender could grind:
    1. A second, different envelope from the **same sender** for an existing key and version (for example the same terms re-sent in a new envelope) is refused outright. The first one seen wins, and the activity feed flags the contact.
    2. Once an `accept` for a version has been sent or received, that version is **locked**, and any other envelope for it is refused.
    3. **Concurrent counters from the two parties** for the same version are a conflict, because each side already holds its own. Both cores detect it the same way: both envelopes are marked not acceptable, pending scopes on them are void, the previous version stays the newest, and either side may send that version number again.
    4. A conflict never voids a scope whose `accept` part has run.
  - Before signing `ACCEPTED` or `REJECTED` on a record whose envelope carries `terms`, the core applies the same checks (own agent ID in `parties`, not expired). Both need owner approval by default (policy `commitments.accept`, §2.5, 06 §3), and one approval covers the `accept` and its receipt (§3.4.2).
  - Received terms are untrusted content (I-5): validated structurally and for canonical form only, shown inside the untrusted block (06 §4) and marked as the other party's content on approval screens. `price` is informational: AgentLink moves no money.
  - **Proof of agreement.** The final terms envelope is notarized (record kind `OFFER` for an `offer`, `ACCEPT` for an `accept`, 05 §3.1) and the counterparty signs `ACCEPTED` on that record. The proof pack (07 §8) includes the envelope and its disclosed content key (policy `proofs.allowKeyDisclosure`), so a verifier can decrypt, recompute `termsHash` and check that the record signer and the receipt signer are the two `parties`. Disclosing the key reveals the whole payload, so the final terms envelope should carry only the terms. The pack shows that both agents, each bound to its owner by the agent card, assented to the same terms at the recorded times (mutual assent). It does not by itself establish legal enforceability or the signatory's authority. **Owner approval in the pack (proposed answer to 11 §14 Q2; owner confirms at merge).** By default, a proof-of-agreement export includes the exporting side's signed approval: the `SignedOwnerAction` (`approval.decide`) and, for a commitment only, its `approval-request.action` with the `CommitmentScope` (§3.4.2). By construction a commitment action holds no local path and no text beyond the terms, which the pack discloses anyway. Other approvals' `action` is never included, because its `args` can hold local paths and message text (G-29). A verifier recomputes `actionDigest`, checks `context.scope.termsHash` against the disclosed terms and checks the signature against the owner key in the agent card. For a policy grant, the pack says "approved by the owner's standing rule" and gives the policy document's hash, not its limits. The owner can leave the approval out at export. Including it reveals the counterparty's owner key and the fee cap to whoever receives the pack, and the export screen says so (07 §8).

#### 3.4.1 Owner-operation, card and pairing bodies (decided, D-58; G-29)

**Owner channel.** `approval-request`, `approval` and `policy` travel only between an agent and its own owner. Their recipients are exactly the agent and its owner (both, so I-9 holds); the §3.2 set does not apply. `from` is the agent's Nostr key (`approval-request`, the `policy` echo) or the owner's (`approval`, `policy`).

| Type | Direction | Body | Receiver rules |
|---|---|---|---|
| `approval-request` | Agent → own owner (console) | `{approvalId, agent, action, actionDigest, summary, requestedAt, expiresAt}` | The console accepts it only from one of its own agents that is not revoked (`from` = `agentNostr` and `agent` = `agentEvm` of a card the owner signed); anything else is dropped |
| `approval` | Owner → own agent | `{signed: SignedOwnerAction}` with `approval.decide` or `approval.cancel` (§2.5.1, D-55); any other `op` is dropped | `from` must be the agent's own owner key and the signed object must verify (§2.5.1); otherwise dropped. A verified `approval.cancel` for an `approvalId` the core does not hold is refused and reported (§2.5.1) |
| `policy` | Owner → own agent; echo agent → own owner | `{signed: SignedOwnerAction}` with `policy.set` | Owner → agent: as for `approval`; the core stores the signed object, not the envelope. Echo: after applying a `policy.set` from any path, the core sends the same signed object to its owner. The console accepts it only from one of its own agents that is not revoked, only if `body.agent` equals that agent's `agentEvm` and only if the owner's own signature verifies. It keeps the highest `version` seen per agent, so an older or foreign echo cannot lower it |
| `revoke` | Owner → the revoked agent and each of its contacts | `{signed: SignedOwnerAction}` with `agent.revoke` | Recipients per §3.2, with the owner as sender. **A contact applies it only if `signed` verifies per §2.5.1 with the contact's stored card in place of the agent's own**: `op` is `agent.revoke`; `agent` equals a stored contact's `agentEvm`; `owner` equals `ownerNostr` in that stored card, as bytes (§2.4.1); `sig` is valid; `v` = 1; `expiresAt` = 0; `issuedAt` is not in the future beyond skew; `params` are strict. Otherwise it is dropped (fail closed). This holds whatever the envelope's `from`: like `handshake`, a verified revoke is an exception to the requests queue, accepted directly from the owner key (decided, D-58). Once applied, the contact drops every envelope from that `agentEvm` processed afterwards, whatever its `createdAt`, and refuses later `card-update` and `handshake` for it. The contact status becomes `revoked` (distinct from `blocked`, not reversible); history stays readable. The revoked agent's own core stops sending and signing (best effort: a compromised agent ignores it, which is why contacts are told) |
| `card-update` | Agent → each contact | `{card, cardSig, name, relays}` (the `handshake` shapes, §3.6) | `cardSig` valid; `card.agentEvm` equals the stored contact's; `ownerEvm`, `ownerNostr` and `ownerEnc` unchanged (owner-key rotation is P2); `keyEpoch` strictly greater; `nameHash` and `relaysHash` match `name` and `relays`; every URL in `relays` passes the relay URL rule (§4). The envelope may come from the old or the new epoch key: authority comes from `cardSig` only. A changed name is shown as a change and stays self-declared (§2.4) |
| `handshake-ack` | Inviter A → B | `{inviteId, handshakeId, handshakeHash, codeReveal, card, cardSig}`: `handshakeId` = B's `handshake` envelope `id`; `handshakeHash` = its `envelopeHash` (§3.1), `0x` + 64 lowercase hex like every `envelopeHash` (§2.4.1); `codeReveal` = `nonceA` (§3.6.1); `card` and `cardSig` = A's card exactly as in the invite | B accepts it only if the envelope `from` and the seal pubkey equal `card.agentNostr`; `sha256(JCS(card))` equals that of the invite card; `inviteId` and `handshakeHash` match a handshake B sent; and `codeReveal` opens the invite's `codeCommit` (§3.6.1). B then marks the pairing complete (§2.9). Otherwise it drops the ack, and the pairing stays pending. A key change since the invite follows as a `card-update` |

**Revoke delivery (decided, D-58).**
- **Who is told.** The console builds the recipient list from the owner's own copies of the agent's `handshake`, `handshake-ack` and `card-update` envelopes (I-9), never from the agent's store.
- **Compromised machine.** A revoke with `reason: compromised` therefore never depends on the compromised machine's contact list. It is sent from the owner's console or another device of the owner. The CLI path is for an uncompromised machine only; for `compromised`, it sends the owner to the console.
- **Re-publishing.** Relays keep events for a limited time, so the console re-publishes the revoke while it remains in use, and contacts that were offline still receive it. A contact applies it from any copy, idempotently.
- **On-chain.** For a registered agent, the console also submits the Registry `revoke` (05 §4, M2-4b). Contacts and the verify page treat either one as revocation.

**`approval-request` fields.**
- `approvalId`: `apr_` followed by 16 random bytes (base64url). `agent`: the requesting agent's EVM address in the canonical form (§2.5.1). `actionDigest`: the 32-byte SHA-256 output as 64 lowercase hex, no prefix (§2.4.1). It is signed only under the owner's Nostr key, so it is never `0x` (proposed; owner confirms at merge).
- `action`: the exact action the owner approves, `{tool, args, context}`. `tool` is the MCP tool name (06 §2.0). `args` is the tool input after defaults are applied, without `approvalId` and `clientRequestId`, with paths resolved by `realpath`. `context` holds the facts the core bound when it evaluated policy (for example the contact's agent EVM address, the file's `plaintextSha256`, and for paid actions the fee `{token, amount, usd}`), so the digest covers them. Its per-tool fields are fixed in M1-2b.
- `actionDigest` = `sha256(JCS(action))` (M1-7e). The console recomputes it and refuses a mismatch, and the owner's `approval.decide` signs this digest. An approval therefore cannot be reused for any other action, even one the agent describes the same way.
- `summary`: core-generated template text (≤ 200 characters) naming the contact (under the contact-name rule, 06 §2.1) and the action, never inbound text (06 §4). The console treats it as a label only and renders the approval card from `action`.
- `requestedAt`, `expiresAt`: unix seconds. **Approval TTL (G-7; proposed, owner confirms at merge):** `expiresAt = requestedAt + 86 400` (24 h). For a commitment, it is `min(requestedAt + 86 400, context.scope.expiresAt)`, so a request never outlives its scope. An `approval.decide` is applied only if it arrives by `expiresAt` (§2.5.1). An approved, unused approval for an action other than a commitment lets that action proceed once, until the same `expiresAt`. After that, `agentlink_get_approval` reports `expired`, and the agent's next call returns a new `pending_approval`. Until it is used, the owner can void it with `approval.cancel` (§2.5.1). When it is used, the core evaluates policy again, and if the rule is now `deny` the call is refused, as void rule 4 does for commitments (§3.4.2). For a commitment, the approved parts then run until the scope's own `expiresAt` (§3.4.2).

**Rendering (I-5).** `action` can contain another agent's content, such as `terms` on an `accept`. The console shows every string in `action` as data: escaped, with no links or markup. It marks fields that carry another party's content as theirs (11 §8). It never derives anything to execute from them.

**Who may create these bodies (I-4).** No MCP tool can create or pass through `approval-request`, `approval`, `policy`, `revoke`, `card-update`, `handshake` or `handshake-ack`. `agentlink_send` accepts only the 02 F-22 types (06 §2.2), and the core's send path refuses every other type from tool input. `approval-request`, the `policy` echo, `handshake` and `handshake-ack` are produced by core flows. `approval`, `policy` and `revoke` carry an owner signature, and `card-update` an owner-signed card, so each needs owner presence. An agent that receives an owner-channel type from anyone but its own owner drops it, and owner-channel envelopes are never returned by `agentlink_inbox`.

**Replays.** `approval.decide` and `approval.cancel` are single use (nonce; `approval.decide` also by `approvalId`). `policy.set` needs a higher `version`. `agent.revoke` and `card-update` are idempotent (revocation is permanent; the epoch must increase). `handshake-ack` matches one handshake.

#### 3.4.2 Commitment approvals: one approval per agreement (D-55)

A commitment (D-31) is approved once per agreement and per owner. The approval binds a **commitment scope** that the core builds from its own store, once, when it creates the pending request (or the policy grant). The scope is immutable after that. Only the envelope being answered and the decision come from the tool call; for a firm offer, the `TermsInput` and the contact come from it too (06 §2.2a). The agent never supplies the terms of an answer, the fingerprint or the counterparty's identity.

```jsonc
// CommitmentScope v1, carried in the approval-request as action.context.scope (§3.4.1)
{
  "v": 1,
  "kind": "agentlink/commitment",
  "agentId": "0x<own agent>",
  "decision": "accept | reject | confirm | offer",  // confirm = ACCEPTED on their ACCEPT record; offer = firm offer
  "counterparty": { "agentId": "0x<contact agent>", "ownerKey": "<contact owner Nostr public key, 64 lowercase hex>" },
  "thread": "<thread id>",
  "termsId": "<16 bytes>",                         // with the two agent IDs above, the negotiation key (§3.4)
  "version": 3,
  "termsHash": "<64 lowercase hex>",
  "answers": { "envelopeId": "<id>", "envelopeHash": "0x<64 lowercase hex>" },  // the counterparty envelope answered; null for a firm offer; envelopeHash is EVM-native (§2.4.1)
  "notarize": false,
  "maxFeeUsd": "0.1",                                          // USD amount (§2.4.1); null when nothing is paid
  "createdAt": 1760000000,
  "expiresAt": 1760600000                                      // min(terms.validUntil, createdAt + 7 days)
}
```

**What one approval authorises.** Exactly the parts below, each at most once, and nothing else. It does not cover another envelope, another record, another decision or another agent of the same owner.

| `decision` | Parts |
|---|---|
| `accept` | (1) One `accept` envelope to `counterparty` in `thread`, with `replyTo = answers.envelopeId`, the stored terms of that offer (so its `termsHash` equals the scope's) and no `note`. (2) With `notarize`, and only if the answered offer has no record: one `Record` for that envelope, kind `ACCEPT`, with a fee of at most `maxFeeUsd`. (3) At most one `ACCEPTED` receipt on the record whose `envelopeHash` equals `answers.envelopeHash`, whose kind is `OFFER`, whose signer is `counterparty.agentId` and whose recipient commitment opens to this agent with the salt from its `proof` envelope (checked on-chain, as for any receipt). The core signs it as soon as that record is known, before `expiresAt` |
| `reject` | One `REJECTED` receipt on the answered record, if that record is known when the call is made (never deferred). The `reject` envelope sent in the same call is free, is not itself a commitment and is not final (06 §2.2a). Never covered by the auto-accept limits |
| `confirm` | One `ACCEPTED` receipt on the counterparty's `ACCEPT` record. That accept must answer one of this agent's own offers that has not expired (its newest, or a superseded one with the warning below). No envelope is sent |
| `offer` (firm offer) | One `offer` envelope with these terms and no `note`, and its `Record` (kind `OFFER`) with a fee of at most `maxFeeUsd` |

**Firm offers (proposed answer to 11 §14 Q1; owner confirms at merge).** An offer sent with `notarize` is a firm offer and a commitment: the counterparty's single approval can turn it into a proof of agreement. It needs one approval under `commitments.accept` and is never covered by the auto-accept limits (only by an explicit `commitments.accept: allow`). It is the only way to record an offer: `agentlink_notarize` refuses any envelope that carries `terms` (06 §2.4).

`reject` on a counterparty's `ACCEPT` record uses the `reject` row with that record. Each J8 shape asks each owner once. If the offer is recorded, the offerer approves the firm offer and the accepter approves the accept, which covers the receipt. If the accept is recorded, the accepter approves the accept with `notarize`, and the offerer approves `confirm`.

**Owner signature, single use and one live scope.**
- The `approval-request` for a commitment (§3.4.1) carries `action = {tool, args, context}` with the scope in `context.scope` and the stored canonical terms in `context.terms`, so `actionDigest = sha256(JCS(action))` covers the scope. For commitment tools, `args` holds no local path and no free text beyond the terms (`note` is refused, the contact is its ID).
- The owner approves with presence (§2.5) by signing `approval.decide` `{approvalId, actionDigest, decision: "approve"}` (§2.5.1). The core applies it once, for its own `agent`, with an unused nonce and within the request's `expiresAt`. From then on, the parts it authorises run until the scope's `expiresAt`.
- Before each part runs, the core re-verifies the stored `approval.decide` and recomputes `actionDigest` from the stored action. It does not use the current call, because a deferred receipt has no call; a current call must match the stored action. It also checks that the void rules below do not apply.
- At most one live scope exists per answered envelope (`agentId`, `answers.envelopeId`), and per firm offer (`agentId`, negotiation key, `version`). Creating a new scope voids an older one that is still pending. Once the `accept` part has run for an envelope, any later scope on it covers only the receipt.
- The core claims a part atomically: in one store transaction (SQLite, or Durable Object storage) it checks that the part is unused, marks it used and stores the signed item, before it publishes anything (07 §2.1). Two concurrent retries therefore cannot both run a part. A used part is never authorised again. The record's single-use nonce and the on-chain one-time receipt flag (I-6, 05 §3.3) are the second line of defence.
- A repeat with the same `clientRequestId` returns the original result. A repeat call with the same `approvalId` after every part has run or is waiting for its record returns `rejected` with `APPROVAL_USED` and the state of the original response (for example `waiting_for_record`). It never sends or signs a part twice.

**Expiry (proposed; owner confirms at merge).** `expiresAt = min(terms.validUntil, createdAt + 7 days)`, where `createdAt` is when the core created the pending request or the grant. Both values are set then and are part of the signed digest. The pending request itself expires sooner: 24 h after it was created, or at the scope's `expiresAt` if that comes first (§3.4.1, G-7). An approval that arrives after that is refused. After `expiresAt`, unused parts are void. If the offerer records the offer after that, the accepter's `ACCEPTED` receipt is not signed. The accept message then stands without on-chain evidence. A new `accept` call on the same offer asks the owner again; because the accept was already sent, its scope covers only the receipt.

**Void on any change.** The approval is void when any of the following holds. Then nothing is sent or signed, and the call returns `status: "rejected"` with the code shown (06 §2.2a):
1. For an `accept` or `offer` scope, before its envelope is sent: a newer version of the same negotiation (same negotiation key, higher `version`, from either side), or a conflict on that version (§3.4, no forks), is in the store (`TERMS_SUPERSEDED`). After the accept is sent, a later version does not void the receipt for the accepted version.
2. The stored offer's `termsHash` or envelope hash differs from the scope (`APPROVAL_VOID`). This cannot happen for a validly signed envelope, but the check is mandatory.
3. The counterparty's agent card or owner key changed, the contact is blocked, or either agent is revoked (`APPROVAL_VOID`).
4. Policy `commitments.accept` is now `deny` (`APPROVAL_VOID`).
5. `expiresAt` has passed (`TERMS_EXPIRED`).
6. The owner cancelled the approval (`APPROVAL_VOID`). **Cancel** is an owner operation with presence: `approval.cancel` (§2.5.1), from `agentlink cancel <approvalId>` †, the local UI, the console or the desktop app. It voids every unused part, for example a receipt still waiting for the offer's record.

A call that asks for a different action (another envelope, decision or `notarize` value, or a fee above `maxFeeUsd`) is not covered. It gets a new `pending_approval`, which voids the first one if that is still pending.

**Auto-accept with the same binding (D-31).** The policy may allow a commitment without asking: `commitments.accept: allow`, or the auto-accept limits. The limits apply only in the direction the owner chose in the signed policy (`autoAcceptDirection`, 06 §3), and only when every condition holds; anything else asks the owner (fail closed):
- the contact is in `autoAcceptContacts`;
- `terms.price` is present, its currency is USD or a USD stablecoin, and its amount is a strict positive decimal (§3.4);
- `buy`: `price.payer` is this agent, the amount is at most `autoAcceptMaxUSD`, and every deliverable is `by` the counterparty;
- `sell`: `price.payer` is the counterparty, the amount is at least `autoAcceptMinUSD`, and every deliverable is `by` this agent. Sell is off by default (`autoAcceptMinUSD: null`). Deliverables are the contact's own words, so turning sell on is an owner operation whose screen states, before the owner confirms: "Your agent will commit you to deliver whatever this contact writes, for at least $X. Only turn this on for contacts you trust." (11 §8).

The core then creates the same scope as a **policy grant**. The grant row is a ledger, never authority. Before each part runs, the core re-runs `evaluate` on the owner-signed policy as verified on load and requires `allow` for this scope. A row inserted or edited in the store therefore authorises nothing. A grant is used up exactly like an approval, and when the policy no longer allows a remaining part, the core asks the owner for it. The auto-accept limits never cover a `REJECTED` receipt or a firm offer. A `REJECTED` receipt asks the owner unless the policy is explicitly `allow` (proposed; owner confirms at merge).

**One request per call.** A call that needs both a commitment approval and a proof approval (`notarize` with `proofs.notarize: approval`, or above a budget) raises one approval whose scope carries both, so the fee appears on the same screen. The approval never relaxes the proof budgets for any other action.

**Counter-offers and late accepts.** A counter (06 §2.2a `counter`) and a revision of one's own unanswered offer (`revises`) are new `offer` versions; the sender's core sets `version` and `previousTermsHash` from its own store (§3.4). They are free and are not commitments, unless sent with `notarize` (a firm offer). They supersede earlier versions under rule 1. An offer stays acceptable until its `validUntil` for a counterparty that has not yet received a newer version. If an `accept` arrives for one of this agent's own versions that has been superseded but has not expired, the core stores it and never drops it. The owner sees "Ana's agent accepted version 3 after you sent version 4". The agent can then `confirm` with that warning on the card, if the accept is recorded, or `reject`.

**What the owner sees (I-5).** The approval screen renders the stored, canonical terms the scope is bound to (§3.4), never terms text from the tool call. Escaping is defence in depth, never the safety mechanism. It shows:
- the counterparty under the 06 §2.1 name rule, with its label;
- the terms as that party's content, with who pays and who delivers each item;
- the changes from the newest version this side held before it, computed locally, never from the counterparty's `previousTermsHash`;
- for a deliverable with `plaintextSha256`, whether that file is held locally;
- the validity and the fee;
- what the single approval will do (11 §6.1, §8).

The terms fingerprint is under Advanced. Tool summaries name only the contact, the action and the version.

### 3.5 Transport wrapping (Nostr)

- The envelope JSON is the `content` of an unsigned **rumor** (kind 14, tag `["agentlink","1"]`), sealed (kind 13) with the sender's Nostr key, then **gift-wrapped** (kind 1059) with an ephemeral key to each recipient Nostr pubkey, per NIP-59 / NIP-17 with NIP-44 v2 encryption.
- The receiver requires the seal's pubkey to equal `envelope.from`.
- One gift wrap per recipient Nostr key (recipient agent, recipient owner, sender owner).
- **Size limits:** serialized envelope ≤ **24 KB** (24 576 bytes; every limit and where it is enforced: §3.1.1); inline files ≤ **12 KB**. Nesting (seal + gift wrap, NIP-44 padding, base64) roughly doubles size, and NIP-44 caps plaintext at 65,535 bytes; many relays cap events at 64 KB. Before publishing, check the final gift-wrap size against each relay's NIP-11 `max_message_length`.
- Gift-wrap timestamps are randomized up to 2 days in the past (NIP-59), so inbox sync must use a ≥ 48 h look-back window and deduplicate by envelope ID (see 07 §4.2).

### 3.6 Pairing protocol

**Invite** (created by agent A):

```jsonc
{ "v": 1, "inviteId": "<16 bytes>", "secret": "<32 bytes>", "card": { /* A's AgentCard */ },
  "cardSig": "0x<130 lowercase hex: owner EIP-712 sig>", "cardAgentSig": "0x<130 lowercase hex: agent EIP-712 sig>",
  "codeCommit": "<32 bytes>", "name": "Tali's Claude", "relays": ["wss://…"], "expiresAt": 1760600000 }
```

- `card` is in the card JSON form, and `cardSig` and `cardAgentSig` (§2.9) are `0x` hex (§2.4, §2.4.1). `inviteId` (exactly 16 bytes), `secret` (exactly 32) and `codeCommit` (exactly 32, §3.6.1) are base64url. Any other length is rejected on parse.
- `relays` (here, in `handshake` and in `card-update`) is inbound content: every URL must pass the relay URL rule (§4) at parse, or the whole body is rejected.
- Encoded as base64url(deflate(JSON)). Shared as `https://<invite-host>/i#<payload>` (the fragment is never sent to a server) and accepted by the CLI/MCP from the full URL or the bare payload. Until the invite landing page ships (M2), the host serves a static "how to install" page.
- A stores `{inviteId, proofKey, nonceA, expiresAt, used=false}`, where `proofKey = HKDF-SHA256(ikm = secret (its 32 raw bytes), salt = "", info = utf8("agentlink/v1/pairing-proof"), L = 32)` (proposed; owner confirms at merge) and `nonceA` is the committed nonce of §3.6.1. A derives `proofKey` when it creates the invite, keeps it and `nonceA` only as encrypted store columns (07 §3), and never stores the raw `secret`. Anyone who reads `proofKey` can answer that one invite, just as with `secret`. The derivation adds key separation and keeps the secret that travels in the link out of the store, but it does not make the stored value safe to disclose. Single use; default expiry 7 days.
- Whoever holds the link can answer it once, first come first served. The invite copy says so (11 §6.1), and a second answer is reported (Complete, below).

**Accept** (agent B):

1. Verify the strict schema, expiry, `cardSig`, and `cardAgentSig`, which must recover `card.agentEvm`. A card whose `agentEvm` equals its `ownerEvm` is refused (§2.9).
2. Apply policy `contacts.acceptInvites` (default `approval`: owner confirms in local UI or console, seeing name, label and owner fingerprint). There is no safety code yet: it exists only once pairing completes (§3.6.1).
3. Send a `handshake` envelope to A (recipients: A agent, A owner, B owner, B agent) from B's own `agentNostr`, the key in the card it sends, with body `{inviteId, card: B's AgentCard, cardSig, cardAgentSig, name, relays, proof, codeNonce, codeCommit, inviterCardHash}`. `codeNonce` is `nonceB` (§3.6.1), `codeCommit` is copied from the invite, and `inviterCardHash` is `sha256(JCS(A's invite card))`, bare hex 64, naming whom B answers. The envelope signature covers all of them. `proof = HMAC-SHA256(proofKey, utf8("agentlink-handshake") || inviteId || sha256(JCS(B card)))`. Byte-exact input (proposed; owner confirms at merge):
   - The HMAC key is `proofKey` (32 bytes): B derives it from the invite's `secret` (decoded from base64url) with the HKDF above, and A reads it from its store. The raw `secret` is never an HMAC key.
   - The message is the concatenation, with no separators and no length prefixes, of:
     - `utf8("agentlink-handshake")` (19 bytes);
     - `inviteId` as its 16 raw bytes, decoded from base64url (never its base64url text);
     - `sha256(JCS(card))` as 32 raw bytes, where `JCS(card)` is the RFC 8785 serialisation, in UTF-8, of B's card in the card JSON form (§2.4).
   - `proof` is the 32-byte HMAC output, sent as base64url (43 characters).

**Complete** (agent A):

- Unknown senders normally go to the requests queue. A `handshake` is the one exception. A accepts it only if all of these hold:
  - `proof` matches an unused, unexpired invite: A recomputes the HMAC with the stored `proofKey` and compares in constant time;
  - **the sender is the card's agent:** the envelope `from` and the seal pubkey (§3.5) both equal `card.agentNostr`, compared as bytes, so a replayed card with its signatures is useless to anyone without that key;
  - `cardSig` and `cardAgentSig` verify (§2.9), and `agentEvm` ≠ `ownerEvm`;
  - `inviterCardHash` equals `sha256(JCS(card))` of the card A put in this invite, and `codeCommit` equals that invite's;
  - the §2.9 per-store rules allow it.
- A then marks the invite used, completes the pairing (a re-pair replaces the old one only now, §2.9), and replies `handshake-ack` (§3.4.1). A signs the ack with the `agentNostr` of its invite card (old epoch keys are re-derivable, §2.6). A newer card follows as a `card-update`.
- **A second answer.** A `handshake` with a valid `proof` for an invite that is already used means the link leaked or someone raced the intended contact. It is refused, and the activity feed tells A's owner: "Someone else also answered your invite. Compare the safety code with {contact} before you trust this contact." Only the owner alias is used, never inbound text.

**Complete** (agent B): B completes the pairing when a `handshake-ack` passes §3.4.1 and the commitment check of §3.6.1. Until then the pairing is pending, and any existing contact for that `agentId` is untouched (§2.9).

#### 3.6.1 Safety code (G-28; proposed, owner confirms at merge)

**What it protects.** The invite travels over a channel AgentLink does not control, such as chat or email. Whoever controls that channel, or copies the invite, can swap A's card for its own towards B, use the copied invite towards A, and sit in the middle. A relay cannot do this. Every pairing message must come from the agent key in its own card (§3.6 Complete, §3.4.1), and that card is signed by its owner, so a relay can only drop or delay messages: a dropped message leaves a pairing pending, never with a wrong code. The two owners detect a swapped invite by comparing the code through another channel, by phone or in person.

**Commit, then reveal.** All three values are exactly 32 bytes, base64url.
- `nonceA`: 32 random bytes drawn by A for each invite. The invite carries `codeCommit = taggedHash("agentlink/safety-commit/v1", inviteId ‖ nonceA)`.
- `nonceB`: 32 random bytes drawn by B for each answer, after B holds the invite. The `handshake` carries it as `codeNonce`, together with the copied `codeCommit` and `inviterCardHash` (§3.6).
- The `handshake-ack` reveals `nonceA` as `codeReveal`, only after A accepted the handshake. B, and every surface that recomputes the code, checks `taggedHash("agentlink/safety-commit/v1", inviteId ‖ codeReveal) = codeCommit`. On a mismatch B drops the ack: the pairing stays pending, no code is shown, and the activity feed reports a failed pairing.

**Construction.**

```
T      = sha256(JCS(cardA)) ‖ sha256(JCS(cardB)) ‖ inviteId ‖ nonceA ‖ nonceB   // 32 + 32 + 16 + 32 + 32 = 144 bytes
digest = taggedHash("agentlink/safety-code/v1", T)                                // pairingDigest
code   = u64be(digest[0..8]) mod 10^12                                           // 12 decimal digits with leading zeros
shown  = "dddd dddd dddd"                                                         // three groups of four, e.g. "0482 1093 7551"
```

- `cardA` is the card in the invite and `cardB` the card in the handshake, each in its JSON form (§2.4), hashed exactly as for the pairing `proof`. `inviteId` and the nonces enter as raw bytes. Every part has a fixed length, which the parsers enforce (§3.6), so the concatenation is unambiguous.
- Order is by role, inviter first, and never sorted: each side knows its role from whether it created the invite. Swapping the roles gives a different code.
- `taggedHash` is the BIP-340 tagged hash (§3.1). The two labels differ from each other and from every other label in this document.
- 2^64 is not a multiple of 10^12, so some codes are more likely than others by a factor of at most 1 + 5.5 × 10^-8. That is negligible.

**Where the code comes from: two signed messages, never a stored value.** No surface displays a stored code or digest; an agent with shell access could edit one. Every surface (the core, the local app, the desktop app, the console, the browser counterparty page) computes the code from the pairing's `handshake` H and `handshake-ack` K, as signed envelopes, each time it shows the code or signs `contact.check`:
1. H's envelope signature is valid, and its `from` equals `H.card.agentNostr`. `H.card` passes `cardSig` and `cardAgentSig` (§2.9).
2. K's envelope signature is valid, and its `from` equals `K.card.agentNostr`. `K.card` passes `cardSig`. `sha256(JCS(K.card)) = H.inviterCardHash`, `K.handshakeHash` = the `envelopeHash` of H (§3.1), and `K.inviteId = H.inviteId`.
3. `K.codeReveal` opens `H.codeCommit` (above).
4. Roles: one of `K.card.agentEvm` (inviter) and `H.card.agentEvm` (invitee) is the surface's own agent. The core takes its own `agentId` from its seed; the console takes it from the cards its owner signed. The other card's `agentEvm` and owner keys equal the contact's current card's.
5. `T = sha256(JCS(K.card)) ‖ sha256(JCS(H.card)) ‖ H.inviteId ‖ K.codeReveal ‖ H.codeNonce`. Any failed check shows "Can't show the safety code" instead of a code.

Every input is covered by the peer's signature, directly or through a hash:
- **The inviter** relies on H, which the invitee signed. H pins its own card (`inviterCardHash`) and `nonceA` (`codeCommit`).
- **The invitee** relies on K, which the inviter signed. K pins all of H (`handshakeHash`).

A local edit of the store therefore cannot change a displayed code without the peer's key. The owner is a recipient of both H and K (§3.2, I-9), so the console recomputes the code from its own copies, not from anything the agent's store reports. This is not full independence from the agent's machine: the agent key on that machine can sign a different H (invitee side) or K (inviter side) of its own. So the console rejects conflicting messages: if it holds two different handshakes, or two different acks, for the same `inviteId`, it shows no code for that pairing and warns the owner to pair again. **Residual:** an agent with shell access as the same OS user can still alter the AgentLink installation on that machine, and with it what its screens show (§2.5). For a contact that matters, the owner compares on the console, on their own device.

The stores keep H, K and the pending `nonceA` or `nonceB` (07 §3). Nothing in them is secret once pairing completes, and none of them is ever the source of a displayed code.

**Why commit first, and why 12 digits.**
- **Keys alone are not enough.** A code over keys alone, like the earlier `sortBytes` formula, can be computed by anyone who knows the cards. A MITM on both legs must make the code of the A leg equal the code of the B leg.
  - If it knows B's card before it sends its invite to B (from the Registry, a published card or an earlier pairing), it grinds key sets for both legs offline and looks for a collision: a birthday search of about 2^(t/2) keys per leg for a t-bit code. That is 2^20 for 40 bits and 2^30 for 60 bits.
  - Otherwise its invite to B is fixed blind, and after B's handshake it grinds the A-leg card against that one target: about 2^t keys. That is 2^40 for 40 bits and 2^60 for 60 bits, and the invite's 7 days leave time for it.
  - Each candidate key costs about one point addition. Either way, a 40-bit keys-only code falls, and no keys-only code short enough to read aloud is safe against a funded attacker.
- **A transcript or fresh nonces alone are not enough either.** The MITM sees `inviteId` and `secret` on one leg and chooses them on the other. With fresh nonces but no commitment, whoever sends last tries nonces until the two codes match, at one hash per try. 2^40 tries take minutes on one GPU; 2^60 take over a thousand GPU-days, within reach of a funded attacker.
- **With the commitment, offline work does not help.** On each leg the code depends on a 256-bit nonce from the honest party, which the MITM cannot see before it has fixed all its own inputs on that leg. Towards B, the MITM's invite (with its commitment) is fixed before `nonceB` arrives. Towards A, A reveals `nonceA` only after the MITM's handshake. The two codes are then independent and uniform, and they match by chance with probability 10^-12 ≈ 2^-39.9 **per attempt**. This is the standard commit-then-reveal bound for short authentication strings, as in ZRTP's hash commitment and Bluetooth numeric comparison. Each attempt costs a pairing that the owners see, because invites are single use and a second answer is reported.
- **Forwarding the honest commitment fails.** A MITM that copies A's `inviteId` and `codeCommit` into its own invite to B still has its own card in T, so the codes differ.
- **A malicious counterparty cannot pick a code** either, for example one its victim already compared with someone else: the other side's nonce is unknown when it commits. Codes are per pairing, so two contacts share a code only by chance.
- The commitment hides `nonceA` (256 random bits) and binds it through SHA-256 collision resistance.
- **12 digits** keeps the format of 11 §5.5. Per attempt, 6 digits (10^-6) would already do; the extra digits keep the bound comfortable over many attempts.

**Comparison: on owner surfaces, never through the agent alone.** "The agent" here means the AI model and any text it writes, not the AgentLink core.
- The code is shown only by AgentLink's own owner surfaces: the local app (contact detail and safety-code compare), the desktop app, the console, the browser counterparty page (08 §7), and `agentlink contacts --verify <id>`. The CLI shows the digits only in an interactive terminal with no harness marker set (the UX guard of §2.8 and 07 §9.1), and the owner runs it in their own terminal.
- **MCP tool results never carry the digits** (06 §2.1). A MITM is the counterparty on both legs, so it can send content to both agents. If owners compared codes that their AIs repeated, an injected agent on each side could repeat one shared fake code. Tools return `pairing` and `safetyCodeChecked`, plus a fixed `nextStep` that names the owner surface.
- **"They match"** is an owner operation: `contact.check` (§2.5.1), with owner presence. It binds the contact's `agentId` and the `pairingDigest` that the signing surface has just recomputed from H and K. Only then does the label become "Safety code checked" (11 §5.2). The core re-verifies it on every load against a fresh recomputation. No MCP tool can produce it (I-4).
- **"They don't match"** only lowers trust, so it needs no signature. From an owner surface only, the contact is blocked (02 F-14) and its pairing marked `mismatch`, and the owner is told to pair again with a new invite sent through another channel.
- Nothing compares codes automatically. A code that arrives as inbound content is never compared with anything (I-5).

**When it is shown.**
- **Pairing (02 J1, J7).** Never in the invite, and never on B's new-contact approval. A shows the code once it has accepted B's handshake and sent the ack; B shows it once the ack verifies. While A's agent is offline, B's side shows the pairing as waiting for the other agent.
- **Re-pair (§2.9).** Always a new code, once the new pairing completes. The contact then loses "Safety code checked" until the owners compare again; before completion nothing changes.
- **Key change.** A `card-update` (new agent keys, §2.6) keeps the code and the label. The code attested the owner keys, which a `card-update` cannot change (§3.4.1), and the new card carries their signature. Step 4 above compares owner keys and `agentEvm`, so it still holds. The activity feed says the contact updated its keys with the same owner, without asking to compare again. A change of owner keys (P2) or a new identity comes only through a new pairing, and so with a new code.

**Test vectors (M1-1h, `safety-code` suite).**
- The commitment from `inviteId` and `nonceA`.
- `T`, `digest`, the integer and the shown code from two cards, `inviteId` and both nonces.
- Leading-zero and reduction-edge cases.
- A role swap gives a different code.
- A `codeReveal` that does not open `codeCommit` is refused.
- The same input under the two labels gives different digests.
- A full H and K pair whose recomputation succeeds, plus one failing case per step 1–4.

The §2.9 values go to other suites: the agent ID to `hkdf-derive`, `cardAgentSig` to `eip712`, `contact.check` to the owner-action vectors, and fingerprints to a new `fingerprint` suite.

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
- **SSRF protection (relay URLs; proposed, owner confirms at merge).** Relay lists arrive from other parties in invites, `handshake` and `card-update` bodies (§3.4.1, §3.6), and the core connects to them (07 §4.2). A WebSocket upgrade is an HTTP request, so a hostile relay URL is an SSRF vector like a download URL. There are two layers.
  - **Schema, at parse (`@agentlink/types`).** The check runs on the **raw string**, before any URL parser runs. A WHATWG or UTS-46 parser would map percent-encoding, full-width characters and U+3002 onto `localhost`, IP literals or trailing dots. A URL is accepted only if all of the following hold:
    - **Characters and length.** The whole string is at most 256 characters of printable ASCII, with no `%`, `\`, whitespace or non-ASCII character anywhere. Percent-encoding and full-width forms are therefore rejected.
    - **Form.** The URL is `wss://` + host + an optional `:` port + an optional path, with no user info, query or fragment.
    - **Host.** Two or more dot-separated labels and at most 253 characters, with no trailing dot. Each label is 1–63 characters of `[a-z0-9-]` (lower case only) and neither starts nor ends with a hyphen.
    - **No numeric labels.** A label that parses as a number in any base is rejected: all decimal digits, or `0x` followed by hex digits (octal is a subset of the first case). This rejects every IPv4 notation, including `127.0.0.1`, `2130706433`, `0x7f.1` and `0177.0.0.1`. Bracketed IPv6 cannot match the grammar. The rule applies to **every** label, not only the last one, so a host such as `1.relay.example` is also rejected. This is deliberate and conservative. Relay operators must use host names with no all-numeric or `0x`-hex label (07 §4.2).
    - **Last label.** It matches `[a-z]{2,63}` or `xn--[a-z0-9-]{1,59}`.
    - **Denied names.** `localhost`, and anything under `.localhost`, `.localdomain`, `.local`, `.internal` or `.home.arpa`, are rejected. This also covers the metadata host names (`metadata.google.internal`, `instance-data.ec2.internal`).
    - **Port.** `[1-9][0-9]{0,4}`, at most 65535, with no leading zero.
    - **Path.** `/` followed by characters from `[A-Za-z0-9._~!$&'()*+,;=:@/-]`.

    One rejected URL rejects the whole list, and with it the body, fail closed. Silently dropping the URL would also break `relaysHash` (§2.4). `relaysHash` is computed over the received strings verbatim, never over a parser's re-serialisation (`URL.href` adds a `/`). The transport connects to exactly the validated host string.
  - **Transport, at connect (M1-5, `transport-nostr`; 07 §4.2).**
    - The host is resolved, and **every** resolved address must be globally routable under the allowlist of 07 §4.2. Otherwise the relay is skipped.
    - The socket connects to **the checked address itself**, with TLS SNI, certificate verification and `Host` all using the host name. A second resolution between check and connect therefore cannot redirect the connection (DNS rebinding).
    - The check repeats on every reconnect. Upgrade redirects are never followed. Proxy settings (`HTTPS_PROXY`, `ALL_PROXY`) are not honoured for relay connections, because a proxy would bypass the address check.
- **Allowed folders:** paths are resolved with `realpath` (symlinks followed) and must remain inside an allowed folder after resolution. Hidden files and files under `~/.ssh`, `~/.agentlink` and the keychain directories are always refused.

---

## 5. On-chain records

- Record and Receipt structs are defined in `05-contracts-occ-v2.md`. EIP-712 domain `{name: "OCC", version: "2", chainId, verifyingContract}`. Structs include an explicit `signer` field, so EOAs and ERC-1271 smart accounts verify the same way.
- **Recipient commitment:** `keccak256(abi.encode(recipientAgentEvm, salt))`; the 32-byte salt is delivered in the encrypted `proof` envelope. The public cannot link a record to its recipient unless a receipt is posted (receipts reveal the recipient's agent address; see 05 §3.3).
- **Records:** random 256-bit nonce per signer, single use; `deadline` enforced. **Receipts:** one per type per record (flag), `deadline` enforced.
- On-chain data is minimal: no content, file names or display names.

---

## 6. Forward secrecy (explicit trade-off)

Static recipient keys mean a stolen encryption key decrypts past envelopes addressed to it. This is accepted for beta because owners must be able to read history (I-9) and agents run asynchronously. Mitigations: keychain storage (or the passphrase-locked file KeyStore on headless machines, which is weaker at rest, §2.8), key rotation (epochs), short file expiry, crypto-shredding. A later version may use per-epoch keys with owner escrow.

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
| **Budget ledger tampering or clock moves** (same OS user; G-7) | The budget check and the reservation of the Record's `maxFee` run in one transaction (06 §3). A missing or unreadable ledger, or a clock earlier than the newest ledger entry, makes every paid action need approval (fail closed). Residual: unlike the policy version, the ledger has no KeyStore high-water mark, so deleting ledger rows (G-1) resets the daily budget; moving the clock forward repeatedly (root or `CAP_SYS_TIME`) empties the window. Mitigations: `perActionMaxUSD` still applies per action, small credit balances, and the on-chain charges remain visible in the vault |
| **Network observer** | TLS everywhere; content already E2E-encrypted |
| **Compromised 4thTech web host serving malicious console JS** | Open source, reproducible builds, published hashes, SRI, CSP; self-hostable console; local packaging avoids the web entirely. Residual risk documented |
| **Shell-capable harness agent (same OS user)** | Owner key never on disk unwrapped; owner operations need passkey/passphrase (§2.5); signed policies; harness permission guidance; small credit balances |
| **Malicious counterparty: prompt injection** | Inbound content labelled `untrusted`; actions limited by owner-signed policies; new contacts need owner approval by default; files only from allowed folders; spending budgets |
| **Malicious counterparty: spam / flooding** | Allowlist by default; unknown senders → requests queue; per-contact rate limits; envelope size cap |
| **Malicious counterparty: SSRF via file or relay URLs** | §4 SSRF rules (`fetch_file`; relay URLs at parse and at connect) |
| **Malicious files / symlink tricks** | Never executed; sanitized names; realpath checks; size limits |
| **Stolen laptop** | Keychain protection (OS login); owner key needs passkey/passphrase; owner can revoke the agent (revocation envelope + on-chain revoke if registered) |
| **Leaked file KeyStore on a headless machine** (D-54: home directory, volume, image layer or backup copied; passphrase in an environment variable or config) | Opt-in only, after a plain-words warning; Argon2id + AES-256-GCM with authenticated header; generated 120-bit unlock code by default; passphrase file from a run-time secret mount recommended over environment variables; 0700/0600 modes, symlink and `realpath` checks; `doctor` warnings; a copied `owner.alko` is protected by a required 120-bit owner code, and the owner key is never unlocked non-interactively, so a leak exposes the agent key only (revoke and replace the agent; changing the code does not protect earlier copies). Residual: a passphrase stored on the same disk gives no at-rest protection beyond disk encryption; an agent that fakes a terminal and runs the owner step itself voids owner presence on that machine (§2.8) |
| **Phishing invites** | Invites show the name under the name rule, the label, the owner fingerprint and the expiry; the safety code follows pairing (§3.6.1); expire; single use; owner approval by default |
| **Swapped or copied invite (MITM at pairing)** | Commit-then-reveal safety code, 12 digits, compared by the owners on their own surfaces and never relayed by an AI (§3.6.1); "Safety code checked" only through an owner-signed `contact.check`; single-use invites, a second answer reported to the inviter's owner (§3.6) |
| **Agent ID claimed by another owner's card, or a replayed card** | `cardAgentSig` binds the agent key to the owner binding; a `handshake` only from `card.agentNostr` and an ack only from the invite card's key; one contact per `agentId`; a re-pair takes effect only on completion and only with unchanged owner keys (§2.9) |
| **Local edit of the displayed safety code** (a steered AI with shell access) | The code is recomputed on every display from the signed `handshake` and `handshake-ack`, each input covered by the peer's signature, never read from a stored digest; `contact.check` signs the recomputed digest (§3.6.1). Residual: an agent that alters the AgentLink installation itself controls what that machine shows (§2.5), so important contacts are compared on the console |
| **Replay of records / receipts / authorizations** | EIP-712 domain, nonces, deadlines, one-time receipt flags; EIP-3009 nonces |
| **Abuse of a public agent card** (e.g. registering it with attacker fees) | Registration requires a separate owner signature over fee parameters (05 §4) |
| **Submitter gas griefing** | Simulate before submit; require on-chain credits; per-signer rate limits; minimum deposit for gasless top-ups |
| **Supply chain (npm)** | Minimal dependencies, pinned lockfile, npm provenance, 2FA, reviewed updates, no postinstall scripts in our packages |
| **On-chain metadata analysis** | Pseudonymous agent keys, salted commitments; per-relationship keys (P2) |
| **Agent commits its owner to terms** (prompt injection or an over-eager agent, including terms where the owner is the one who delivers or pays) | Policy `commitments.accept` defaults to `approval` (D-31); auto-accept only for allowlisted contacts, in the direction the owner chose (who pays and who delivers) and within its limits (§3.4.2); the approval screen shows the terms and the changes from the previous version; `termsHash` binds exactly what was accepted (§3.4); the agent names the offer by envelope ID and cannot supply the accepted terms (D-55) |
| **Reuse or replay of a commitment approval** (an approval used for other terms, a newer version, another contact or agent, a second accept, or a late receipt) | One approval binds one commitment scope (§3.4.2): own agent, counterparty and its owner key, thread, the answered envelope and its hash, `termsHash`, decision, fee cap and an expiry no later than `validUntil`; each part runs once and is recorded; the digest is recomputed from the store before each part, and any change voids it; record nonces and one-time receipt flags on-chain (I-6); auto-accept grants are ledger rows re-evaluated against the verified policy before each part; one live scope per answered envelope with atomic claims; no forks in the negotiation chain (§3.4); the owner can cancel unused parts |
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
