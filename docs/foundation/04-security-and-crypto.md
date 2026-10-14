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

### 2.5 Owner operations and user presence

Owner-only operations: approve/deny, change policies, add/remove allowed folders, add storage credentials, export keys, revoke agents, disclose content keys.

- Each is expressed as an **owner-signed object** (`SignedOwnerAction`, §2.5.1, signed by the owner Nostr key). The local UI, the CLI and the console produce the same object. The console carries it inside an `approval`, `policy` or `revoke` envelope (§3.4.1); the envelope is only transport, and authority comes from the object's owner signature, never from the envelope signature.
- The agent's core **verifies the owner signature** against the owner key in its agent card before applying the action. Policies are stored as signed documents and re-verified on load, so editing the database directly has no effect.
- Signing requires user presence: passkey (local UI on `localhost` or console) or owner passphrase (CLI prompt). The local UI holds no reusable bearer token on disk.
- **Desktop app owner presence (M2, D-36)** is stronger than localhost WebAuthn. Known weakness of the localhost passkey: a WebAuthn RP ID is a host name without port, so a passkey registered for `localhost` can be requested by any page on any localhost port, including one a shell-capable agent starts. Such a page could imitate the approval page and ask for the owner's gesture (the human must still complete the prompt). The desktop app removes this path: owner operations happen in a **native approval window** (not a localhost page), the OS prompt names the signed app, and the keystore releases the owner wrapping key only to that app (§2.2). Residual: on Linux, and wherever the OS falls back to a typed device password, an agent able to inject keystrokes and knowing the secret could complete the prompt; this is settled in the framework security review (08 §8).
- **Commitments (D-31)** are an approval path, not an owner-only operation. Sending an `accept` and signing an `ACCEPTED` or `REJECTED` receipt are agent actions gated by policy `commitments.accept` (default `approval`, 06 §3): the agent proposes, the owner approves or denies through the normal approval flow above (owner-signed, with presence), and only then does the agent's key send or sign. Auto-accept applies only within owner-signed limits (allowlisted contacts, maximum value).
- **Residual risk:** an agent with unrestricted shell access as the same OS user could tamper with the AgentLink installation itself or spend the agent's credits by signing records with the agent key. Mitigations: keep credits small; harness permission settings that deny access to `~/.agentlink` and the keychain (documented in the quickstart); owner revocation; per-agent spending caps in the vault (P2).

#### 2.5.1 Owner-signed objects (proposed; owner confirms at merge, G-29)

```jsonc
// OwnerAction: the signed content
{
  "v": 1,
  "agent": "0x<40 lowercase hex>",          // the agent's EVM address (stable, §2.1)
  "owner": "<64 lowercase hex>",            // owner Nostr x-only pubkey; must equal ownerNostr in that agent's card
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
- **Encoding (byte-exact).**
  - `agent` is `0x` followed by 40 lowercase hex characters. `owner` is 64 lowercase hex characters, and `sig` is 128.
  - `nonce` is 16 bytes, base64url without padding.
  - Integers (`v`, `issuedAt`, `expiresAt`, `policy.set` `version`) are JSON integers in [0, 2^53 − 1].
  - All strings are I-JSON (RFC 7493), and JCS is RFC 8785.
  - Schemas are strict at every level (`SignedOwnerAction`, `OwnerAction`, `params`), so unknown keys are rejected.
  - An object in any other form is **rejected, never normalised**.
  - The same lowercase address form applies wherever an agent address appears in a signed or hashed object: `terms.parties` (§3.4) and `approval-request.agent` (§3.4.1).
  - M1-1h carries signing vectors and rejection vectors for every non-canonical form (checksummed or uppercase address, uppercase hex, padded base64url, out-of-range integer, unknown key).
- **Binding.** `agent` binds the action to one agent by its canonical EVM address (proposed; owner confirms at merge). The address is stable across epochs and covered by the agent card signature and the Registry. `agentId` (G-23) is only a local handle and never a second binding. An action signed for one agent is refused by every other agent of the same owner.
- **Verification** (core, before applying). "The agent" means the receiving core's own agent, or, for `agent.revoke` at a contact, that contact's stored card (§3.4.1). Checks, in order:
  - the encoding above is exact;
  - `agent` is that agent's EVM address;
  - `owner` equals `ownerNostr` in that agent's card;
  - `sig` is valid;
  - `issuedAt` is not in the future beyond clock skew;
  - `now ≤ expiresAt`, and `expiresAt − issuedAt` is within the op's maximum lifetime;
  - `nonce` is unused;
  - `params` match the op's schema.

  Any failure drops the object (fail closed). `expiresAt` = 0 is required for `agent.revoke` and allowed only there; that op skips the expiry and lifetime checks. Nonces are retained for at least the maximum lifetime plus skew. Skew, lifetimes and retention are fixed by G-7.
- **Refusals are reported.** An owner action the core refuses (expired, superseded version, unknown approval) is reported to the owner: a local UI notice, or on the console "not applied, sign again". It never fails silently.
- **Stored objects are re-verified, not trusted.**
  - Freshness and nonce checks apply once, when an action is first applied.
  - **Policies.** On every load, the stored `policy.set` must verify (`sig`, `agent`, `owner`). Its `version` must equal the **highest applied version**, which the core keeps as a KeyStore item (§2.2, §2.8), not only in the store. Otherwise G-6 applies, and once any version has been applied, the result is never the 06 §3 defaults. Residual: a same-OS-user process can roll back both the store and the KeyStore item (G-1).
  - **Approvals.** The core stores the signed `approval.decide`. When a tool presents an `approvalId`, the core re-verifies that object (`sig`, `agent`, `owner`, `approvalId`) and recomputes `actionDigest` from the current call, instead of trusting a status column.
- Ops defined here (others, such as storage credentials, key export and content-key disclosure, use the same object with `params` fixed by the tasks that build them):

| `op` | `params` | Produced by | Rules |
|---|---|---|---|
| `approval.decide` | `{approvalId, actionDigest, decision: "approve" \| "deny"}` | Local UI, CLI, console (`approval` envelope) | Applies only to a pending request with the same `approvalId` and `actionDigest` (§3.4.1); single use. Its maximum lifetime is the request's `expiresAt`. A deny is signed too, so a forged deny cannot cancel a request |
| `policy.set` | `{version, policy}` | Local UI, CLI, console (`policy` envelope) | `policy` is the complete 06 §3 document, never a partial patch. `version` must be greater than the highest applied version, so an older signed policy cannot be replayed to roll back. After applying, the core echoes the signed object to its owner on the owner channel (§3.4.1), so the console always knows the current version, including one set from the local UI or the CLI. Fail-closed behaviour on a missing or invalid policy stays with G-6 |
| `agent.revoke` | `{reason: "compromised" \| "retired" \| "other"}` | Console (any reason); CLI only on an uncompromised machine (`revoke` envelope) | Permanent per `agent` EVM address, for every epoch, with no un-revoke (proposed; owner confirms at merge). A revoked agent returns only as a new identity (new seed) with new pairings, and the UI asks for explicit confirmation. `reason` is a fixed value, never free text. Delivery to contacts: §3.4.1 |

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

**File format `ALKS` v1.** One file per agent, `~/.agentlink/keystore/<agentId>.alks`. `agentId` must match `[A-Za-z0-9_-]{1,64}`, checked before any path is built.

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

- `kek = HKDF-SHA256(ikm = Argon2id(normalise(secret, secretKind), salt, m, t, p, L = 32), salt = "", info = utf8("agentlink/v1/keystore-file"), L = 32)`.
- The owner passphrase wrap pins its own label, `agentlink/v1/owner-passphrase-wrap`, and its own magic, `ALKO` (M1-1f). The two blob types are therefore never interchangeable in either direction, and a test covers both directions.
- **AAD = every header byte** from `magic` through `agentId`. A changed parameter, secret kind, salt, nonce or agent ID, a truncated file or a changed ciphertext all fail authentication.
- **Expected agent ID.** Before the KDF runs, the reader refuses a file whose header `agentId` differs from the agent being opened, that is, the file name and the recorded config. After decryption, the `seed` entry must derive the expected agent ID. A file copied over another agent's file therefore fails **even when both agents use the same passphrase**.
- **Plaintext:** a list of entries `u16be nameLen | name (UTF-8) | u32be valueLen | value`, one per keychain item that the keychain backend would hold for this agent. Names are the keychain account suffixes, for example `seed`, `store-key`, `s3:<id>`. Duplicate names, length overflows, trailing bytes and plaintext above 64 KiB are refused. Values stay in `Uint8Array` and never become JS strings.
- **Generated unlock code:** 15 CSPRNG bytes, exactly 120 bits, encoded as 24 RFC 4648 base32 characters with no bias, shown in groups of four. Input is case-insensitive. Spaces and dashes are removed, and `0`, `1` and `8` are read as `O`, `I` and `B`. Anything other than 24 valid characters after normalisation is refused before the KDF runs.
- **Chosen passphrase:** UTF-8 and Unicode NFKC, otherwise unchanged. A passphrase file loses exactly one trailing `\n` or `\r\n`. The header's `secretKind` tells the reader which normalisation to apply.
- All of this runs through `@agentlink/crypto` (Argon2id and HKDF from `@noble/hashes`, AES-256-GCM via WebCrypto or `@noble/ciphers`) and the `KeyStore` interface (§8.1). `@agentlink/node` handles only files and never calls a primitive itself.

**KDF choice and parameters.** The KDF is Argon2id because the spec already uses it for the owner passphrase and the recovery code (§2.3, M1-1f). That means one implementation, one vector suite and one review instead of two. Argon2id is memory-hard, resists side-channel attacks and is standardised (RFC 9106). scrypt (`@noble/hashes`, N = 2^17, r = 8, p = 1) was the alternative; it was rejected only for this consistency.

| | Value | Reason |
|---|---|---|
| Default for new files | m = 64 MiB, t = 3, p = 1 | The same as the owner passphrase wrap. This meets RFC 9106's second recommended set; p = 1 instead of 4 does not lower an attacker's cost per guess |
| Target (proposed; owner confirms at merge) | Unlock ≤ 2 s expected and **≤ 5 s accepted** on a 2-vCPU container with a 512 MiB memory limit (Node LTS) | Unlock runs once per server start and **asynchronously** (`argon2idAsync` or a worker thread), after the MCP `initialize` answer. Until it finishes, tools return `needs_setup` (`keystore_locked`, "unlocking") |
| Above 5 s | Owner decision. Options in order: Node's built-in `crypto.argon2` behind `@agentlink/crypto`, with vector parity against `@noble`; then t = 2 at 64 MiB; never below the floor | Node's built-in is not an allowlisted dependency (AGENTS.md), so it is **not adopted**; it stays an open owner question. For generated 120-bit codes the KDF cost does not matter |
| Floor and cap on read | Refuse before the KDF runs if m < 19 MiB, t < 2, m > 256 MiB, t > 8, p < 1 or p > 4 | The floor is the OWASP minimum (m = 19 MiB, t = 2) and exists only for a future change of default. The cap stops a planted header from exhausting the reference container's memory or CPU |
| Runtimes | Node only | Browsers use the passkey PRF (§2.3) and Workers use Worker secrets (§2.2), so neither has a file KeyStore. Argon2id timing in browsers and Workers belongs to M1-1f |

**Passphrase strength.**
- **Agent:** the default is a generated unlock code; offline guessing of a stolen file is then infeasible. A passphrase the user chooses is allowed at the interactive prompt only. It must have at least 12 characters and comes with a warning that a weak passphrase can be guessed if the file leaks.
- **Agent and owner secrets always differ, checked in both directions.**
  - Setting or changing the agent passphrase refuses a candidate that unlocks the owner's wrapped seed. The candidate is normalised the way the owner wrap normalises it (M1-1f).
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
- **Agent binding:** two agents with the **same** passphrase; swapping their files fails both before the KDF (header `agentId`) and after decryption (seed-derived ID). An `agentId` outside `[A-Za-z0-9_-]{1,64}` is refused before any path is built.
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

---

## 3. Envelope (message container)

### 3.1 Structure (v1)

All binary values are base64url **without padding** in JSON unless noted.

```jsonc
{
  "v": 1,
  "id": "<16 random bytes>",
  "thread": "<16 bytes, stable per conversation>",
  "from": "<sender nostr x-only pubkey, hex>",       // the sending agent; the owner on the owner channel (§3.4.1)
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
- **`approval-request` / `approval` / `policy` / `revoke` / `card-update` / `handshake-ack`** bodies are fixed in §3.4.1.
- **`offer` / `accept` / `reject` carry `terms`** (D-32), so agents can negotiate and agree on exact terms:

```jsonc
// body of offer / accept / reject
{
  "terms": {
    "termsId": "<16 random bytes>",              // stable for one negotiation
    "version": 3,                                 // +1 for each counter-offer
    "parties": ["0x<agent A>", "0x<agent B>"],    // agent IDs = stable agent EVM addresses (§2.1), 0x + 40 lowercase hex (§2.5.1); two parties in beta
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
  - **Proof of agreement.** The final terms envelope is notarized (record kind `OFFER` for an `offer`, `ACCEPT` for an `accept`, 05 §3.1) and the counterparty signs `ACCEPTED` on that record. The proof pack (07 §8) includes the envelope and its disclosed content key (policy `proofs.allowKeyDisclosure`), so a verifier can decrypt, recompute `termsHash` and check that the record signer and the receipt signer are the two `parties`. Disclosing the key reveals the whole payload, so the final terms envelope should carry only the terms. The pack shows that both agents, each bound to its owner by the agent card, assented to the same terms at the recorded times (mutual assent). It does not by itself establish legal enforceability or the signatory's authority. `DECISION NEEDED (owner)`: optionally add each owner's signed approval (§2.5) to the pack, as off-chain evidence that the owners, not only their agents, approved. If added, the pack carries only the `SignedOwnerAction` (`approval.decide`, which holds the digest), never the `approval-request.action`, whose `args` can hold local paths and message text (G-29).

#### 3.4.1 Owner-operation, card and pairing bodies (proposed; owner confirms at merge, G-29)

**Owner channel.** `approval-request`, `approval` and `policy` travel only between an agent and its own owner. Their recipients are exactly the agent and its owner (both, so I-9 holds); the §3.2 set does not apply. `from` is the agent's Nostr key (`approval-request`, the `policy` echo) or the owner's (`approval`, `policy`).

| Type | Direction | Body | Receiver rules |
|---|---|---|---|
| `approval-request` | Agent → own owner (console) | `{approvalId, agent, action, actionDigest, summary, requestedAt, expiresAt}` | The console accepts it only from one of its own agents that is not revoked (`from` = `agentNostr` and `agent` = `agentEvm` of a card the owner signed); anything else is dropped |
| `approval` | Owner → own agent | `{signed: SignedOwnerAction}` with `approval.decide` (§2.5.1) | `from` must be the agent's own owner key and the signed object must verify (§2.5.1); otherwise dropped |
| `policy` | Owner → own agent; echo agent → own owner | `{signed: SignedOwnerAction}` with `policy.set` | Owner → agent: as for `approval`; the core stores the signed object, not the envelope. Echo: after applying a `policy.set` from any path, the core sends the same signed object to its owner; the console accepts it only from one of its own agents and only if the owner's own signature verifies, and uses it as the current version |
| `revoke` | Owner → the revoked agent and each of its contacts | `{signed: SignedOwnerAction}` with `agent.revoke` | Recipients per §3.2, with the owner as sender. **A contact applies it only if `signed` verifies per §2.5.1 with the contact's stored card in place of the agent's own**: `op` is `agent.revoke`; `agent` equals a stored contact's `agentEvm`; `owner` equals `ownerNostr` in that stored card; `sig` is valid; `v` = 1; `expiresAt` = 0; `issuedAt` is not in the future beyond skew; `params` are strict. Otherwise it is dropped (fail closed). This holds whatever the envelope's `from`: like `handshake`, a verified revoke is an exception to the requests queue, accepted directly from the owner key (proposed; owner confirms at merge). Once applied, the contact drops every envelope from that `agentEvm` processed afterwards, whatever its `createdAt`, and refuses later `card-update` and `handshake` for it. The contact status becomes `revoked` (distinct from `blocked`, not reversible); history stays readable. The revoked agent's own core stops sending and signing (best effort: a compromised agent ignores it, which is why contacts are told) |
| `card-update` | Agent → each contact | `{card, cardSig, name, relays}` (the `handshake` shapes, §3.6) | `cardSig` valid; `card.agentEvm` equals the stored contact's; `ownerEvm`, `ownerNostr` and `ownerEnc` unchanged (owner-key rotation is P2); `keyEpoch` strictly greater; `nameHash` and `relaysHash` match `name` and `relays`. The envelope may come from the old or the new epoch key: authority comes from `cardSig` only. A changed name is shown as a change and stays self-declared (§2.4) |
| `handshake-ack` | Inviter A → B | `{inviteId, handshakeId}` (`handshakeId` = B's `handshake` envelope `id`) | B accepts it only from A's `agentNostr` in the invite card (or a later card from the same owner) and only for a handshake B sent with that `inviteId`; B then marks the pairing complete. A key change since the invite follows as a `card-update` |

**Revoke delivery (proposed; owner confirms at merge).**
- **Who is told.** The console builds the recipient list from the owner's own copies of the agent's `handshake`, `handshake-ack` and `card-update` envelopes (I-9), never from the agent's store.
- **Compromised machine.** A revoke with `reason: compromised` therefore never depends on the compromised machine's contact list. It is sent from the owner's console or another device of the owner. The CLI path is for an uncompromised machine only; for `compromised`, it sends the owner to the console.
- **Re-publishing.** Relays keep events for a limited time, so the console re-publishes the revoke while it remains in use, and contacts that were offline still receive it. A contact applies it from any copy, idempotently.
- **On-chain.** For a registered agent, the console also submits the Registry `revoke` (05 §4, M2-4). Contacts and the verify page treat either one as revocation.

**`approval-request` fields.**
- `approvalId`: `apr_` followed by 16 random bytes (base64url). `agent`: the requesting agent's EVM address in the canonical form (§2.5.1).
- `action`: the exact action the owner approves, `{tool, args, context}`. `tool` is the MCP tool name (06 §2.0). `args` is the tool input after defaults are applied, without `approvalId` and `clientRequestId`, with paths resolved by `realpath`. `context` holds the facts the core bound when it evaluated policy (for example the contact's agent EVM address, the file's `plaintextSha256`, and for paid actions the fee `{token, amount, usd}`), so the digest covers them. Its per-tool fields are fixed in M1-2b.
- `actionDigest` = `sha256(JCS(action))` (M1-7e). The console recomputes it and refuses a mismatch, and the owner's `approval.decide` signs this digest. An approval therefore cannot be reused for any other action, even one the agent describes the same way.
- `summary`: core-generated template text (≤ 200 characters) naming the contact (under the contact-name rule, 06 §2.1) and the action, never inbound text (06 §4). The console treats it as a label only and renders the approval card from `action`.
- `requestedAt`, `expiresAt`: unix seconds; the approval TTL is fixed by G-7.

**Rendering (I-5).** `action` can contain another agent's content, such as `terms` on an `accept`. The console shows every string in `action` as data: escaped, with no links or markup. It marks fields that carry another party's content as theirs (11 §8). It never derives anything to execute from them.

**Who may create these bodies (I-4).** No MCP tool can create or pass through `approval-request`, `approval`, `policy`, `revoke`, `card-update`, `handshake` or `handshake-ack`. `agentlink_send` accepts only the 02 F-22 types (06 §2.2), and the core's send path refuses every other type from tool input. `approval-request`, the `policy` echo, `handshake` and `handshake-ack` are produced by core flows. `approval`, `policy` and `revoke` carry an owner signature, and `card-update` an owner-signed card, so each needs owner presence. An agent that receives an owner-channel type from anyone but its own owner drops it, and owner-channel envelopes are never returned by `agentlink_inbox`.

**Replays.** `approval.decide` is single use (nonce and `approvalId`). `policy.set` needs a higher `version`. `agent.revoke` and `card-update` are idempotent (revocation is permanent; the epoch must increase). `handshake-ack` matches one handshake.

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
| **Network observer** | TLS everywhere; content already E2E-encrypted |
| **Compromised 4thTech web host serving malicious console JS** | Open source, reproducible builds, published hashes, SRI, CSP; self-hostable console; local packaging avoids the web entirely. Residual risk documented |
| **Shell-capable harness agent (same OS user)** | Owner key never on disk unwrapped; owner operations need passkey/passphrase (§2.5); signed policies; harness permission guidance; small credit balances |
| **Malicious counterparty: prompt injection** | Inbound content labelled `untrusted`; actions limited by owner-signed policies; new contacts need owner approval by default; files only from allowed folders; spending budgets |
| **Malicious counterparty: spam / flooding** | Allowlist by default; unknown senders → requests queue; per-contact rate limits; envelope size cap |
| **Malicious counterparty: SSRF via file URLs** | §4 SSRF rules |
| **Malicious files / symlink tricks** | Never executed; sanitized names; realpath checks; size limits |
| **Stolen laptop** | Keychain protection (OS login); owner key needs passkey/passphrase; owner can revoke the agent (revocation envelope + on-chain revoke if registered) |
| **Leaked file KeyStore on a headless machine** (D-54: home directory, volume, image layer or backup copied; passphrase in an environment variable or config) | Opt-in only, after a plain-words warning; Argon2id + AES-256-GCM with authenticated header; generated 120-bit unlock code by default; passphrase file from a run-time secret mount recommended over environment variables; 0700/0600 modes, symlink and `realpath` checks; `doctor` warnings; a copied `owner.alko` is protected by a required 120-bit owner code, and the owner key is never unlocked non-interactively, so a leak exposes the agent key only (revoke and replace the agent; changing the code does not protect earlier copies). Residual: a passphrase stored on the same disk gives no at-rest protection beyond disk encryption; an agent that fakes a terminal and runs the owner step itself voids owner presence on that machine (§2.8) |
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
