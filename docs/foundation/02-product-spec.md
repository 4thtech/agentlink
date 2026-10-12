# 02 — Product Specification

Defines **what** AgentLink does. How it is built is in 03–08. Requirement IDs (F-xx) are referenced by the build plan (10).

Priority: **P0** = beta must-have · **P1** = beta should-have · **P2** = post-beta.

**Overriding UX rule (00 principle 4, D-39):** users never need a wallet, browser extension, gas, seed phrase or chain choice, and never see chain names or hex unless they open "Advanced". Locally there is no login (OS keychain, plus biometrics in the desktop app); the console signs in with a passkey (recovery code fallback). The only setup step is adding AgentLink to the harness, and the user's own agent can do that (F-01, F-09). When a feature or trade-off conflicts with this rule, the rule wins, except that it never weakens a security invariant (04 §1) or owner presence for owner operations.

---

## 1. Users

| Persona | Description | Main need |
|---|---|---|
| **Pro user** | Consultant, lawyer, accountant, founder using Claude Desktop/Code, Codex or Gemini CLI daily | Hand work to other people's agents securely, with proof when it matters |
| **Owner (non-technical)** | Business owner whose staff or agents use AgentLink | See and approve what agents exchanged; export proof |
| **Agent builder** | Developer running always-on agents (bots, services) | Reliable, encrypted inbox and endpoint; programmatic notarization |
| **Integrator** | Company embedding the SDK in its own app | Earn integrator fees; offer proof features to its users |
| **Verifier** | Counterparty, auditor, lawyer, court | Check a proof pack without an account |

---

## 2. Product surfaces

| Surface | What it is | Priority |
|---|---|---|
| **MCP server: local** | `npx` package; runs on the user's computer; keys in OS keychain | P0 (M1) |
| **Local approval UI** | Small web page served on `127.0.0.1` by the local MCP for approvals and settings. Its screens become the desktop app's UI in M2 | P0 (M1) |
| **Desktop apps (macOS, Windows, Linux)** | Signed, auto-updating tray app hosting the same local MCP server (same tools); native approval window with OS biometrics (Touch ID / Windows Hello) gating the owner key; harness auto-setup (D-36, 08 §8). The `npx` package stays supported | P1 (M2) |
| **CLI** | `agentlink` command for setup, pairing, policies, backup | P0 |
| **Owner console** | Hosted PWA (static, zero-knowledge); passkey login; works on mobile | P1 (M2) |
| **Self-host cloud template** | One-click Cloudflare Worker: always-on agent with remote MCP endpoint, in the user's own account | P1 (M2) |
| **Verify page** | Public page and CLI command to verify a proof pack | P0 (CLI) / P1 (page) |
| **Invite landing page** | Page a recipient opens from an invite link; explains AgentLink and how to accept | P1 |
| **Browser counterparty (view and accept)** | Zero-install web client opened from the invite link: a counterparty without an agent views what was sent and accepts or rejects it in the browser; keys generated in the browser, same identity model as the console (D-35, F-15, 08 §7) | P1 (M2) |
| **Hosted remote MCP (approval mode)** | 4thTech-hosted endpoint for ChatGPT web / claude.ai, all signing done in the owner's browser | P2 (M4) |

---

## 3. Features

### Identity and setup

| ID | Feature | Detail | Priority |
|---|---|---|---|
| F-01 | **One-command install** | `npx @4thtech/agentlink init` creates identity, stores keys in OS keychain, prints the harness snippet. Also: one-click Claude Desktop extension bundle. **Agent-assisted:** the user's own agent can run `init` from a documented install prompt (F-09); `init` detects the harness, shows the exact config change and applies it only after the user confirms; owner setup (passkey or passphrase) always happens with the user present (06 §7, D-39) | P0 |
| F-02 | **Agent identity** | Each agent gets keys (signing, Nostr, encryption) generated locally. Never leaves the device except as an encrypted backup the user controls | P0 |
| F-03 | **Owner identity** | Owner keys created by the local UI (localhost passkey or owner passphrase), the desktop app (OS biometrics, M2) or the console (passkey). The owner key is never stored unwrapped on the agent's machine. Owner signs an *agent card* binding agents to the owner | P0 |
| F-04 | **Recovery kit** | Encrypted backup (passphrase or passkey PRF) exportable as a file and optionally stored as an encrypted Nostr event. Nothing stored by 4thTech | P0 |
| F-05 | **Multiple agents per owner** | One owner, many agents (laptop Claude, cloud bot, colleague's Codex); owner sees all | P1 |
| F-06 | **Display names and avatars** | Local, user-chosen; shown on contact cards | P1 |
| F-07 | **Domain verification** | The owner proves control of a domain (DNS TXT `_agentlink.<domain>` or `https://<domain>/.well-known/agentlink.json` holding the owner key fingerprint, signed by the owner). Clients check it when showing a contact and label the owner "verified domain" or "self-declared"; the Registry may record a hash of the claim (04 §2.7, D-34) | P1 (M2) |
| F-08 | **Qualified e-signature (research)** | Research EU qualified electronic signatures (eIDAS) for owner identity and agreements, to add legal weight beyond F-07 (D-34) | P2 (M4) |
| F-09 | **Install prompt per harness, in docs and skill** | A short, copy-paste prompt per harness (Claude Code, Claude Desktop, Codex, Gemini CLI, Antigravity, Cursor…) that the user gives to their agent to install AgentLink; published in the docs and in the AgentLink skill (06 §7.1, D-39) | P0 |

### Contacts

| ID | Feature | Detail | Priority |
|---|---|---|---|
| F-10 | **Invite link / QR** | Creates an invite containing the agent card (public keys, owner key, name, relays). The secret part is in the URL fragment so no server sees it | P0 |
| F-11 | **Accept invite** | Agent or owner accepts; both sides store the contact; first encrypted handshake message confirms pairing | P0 |
| F-12 | **Contact verification** | Safety number / short code to compare out of band; optional on-chain verified registration badge (paid, F-41) | P1 |
| F-13 | **Allowlist by default** | Agents accept messages only from paired contacts. Unknown senders land in a "requests" queue for the owner | P0 |
| F-14 | **Block / remove contact** | Locally; future messages dropped | P0 |
| F-15 | **Browser counterparty** | A recipient without an agent opens the invite link and chooses "View and accept in browser": passkey-protected keys are generated in the browser (same model as the console), the contact is paired, and they can read what was sent, accept or reject offers with `terms`, sign the ACCEPTED or REJECTED receipt and export the proof. A recovery kit is offered. View and accept only, not a chat app (§6) (D-35, 08 §7) | P1 (M2) |

### Talk (free)

| ID | Feature | Detail | Priority |
|---|---|---|---|
| F-20 | **Send message** | End-to-end encrypted to the contact's agent; copies wrapped for both owners | P0 |
| F-21 | **Inbox** | `check_inbox` returns new messages; persisted locally; threads per contact | P0 |
| F-22 | **Structured messages** | Typed payloads: `text`, `request`, `offer`, `accept`, `reject`, `delivery`, `note`, with optional JSON body. `offer`, `accept` and `reject` carry a structured `terms` object (parties, subject, deliverables, optional price, deadlines, validity, link to the previous version); an `accept` quotes the `termsHash` it accepts (04 §3.4, D-32). Sending `accept` needs owner approval by default (F-61) | P0 (`offer` / `accept` / `reject` with `terms`) / P1 (other types) |
| F-23 | **Delivery status (off-chain)** | Free, signed "received" acknowledgement over Talk (not on-chain) | P1 |
| F-24 | **Group threads** | 3+ participants | P2 |

### Send file (free)

| ID | Feature | Detail | Priority |
|---|---|---|---|
| F-30 | **Inline small files** | Files ≤ 12 KB travel inside the encrypted envelope (transport size limit) | P0 |
| F-31 | **Send file via own storage** | File encrypted on device, uploaded to the user's storage; recipient receives a time-limited download link plus key inside the envelope | P0 |
| F-32 | **Connect storage** | Guided setup for S3-compatible storage (Cloudflare R2, AWS S3, Hetzner, Scaleway, Backblaze, MinIO). Credentials stored locally in keychain | P0 |
| F-33 | **Expiry and crypto-shred** | Default and maximum 7 days (recipient can request a fresh link). On expiry (default) or confirmed receipt (configurable), the sender deletes the object and both sides discard the file key. Optional owner archive keeps owner copies (P1) | P0 |
| F-34 | **Integrity check** | Recipient verifies the SHA-256 of the ciphertext before decrypting | P0 |
| F-35 | **IPFS pinning adapter** | Optional backend (Pinata / Filebase / Storacha) | P2 |

### Proof (paid)

| ID | Feature | Detail | Priority |
|---|---|---|---|
| F-40 | **Notarize** | Records the envelope hash on-chain with sender signature, recipient commitment, kind, timestamp. One flag on `send_message` / `send_file`, or later on any past message | P0 |
| F-41 | **Verified registration** | On-chain agent card registration (agent ↔ owner binding), shown as a verified badge; ERC-8004 link later | P1 |
| F-42 | **Receipts** | Recipient signs `DELIVERED`, `OPENED`, `ACCEPTED` or `REJECTED`; recorded on-chain against the record. Recipient pays nothing (prepaid by sender's fee). `ACCEPTED` and `REJECTED` are commitments and need owner approval by default (F-61) | P0 |
| F-43 | **Proof pack export** | JSON (+ human-readable PDF later) with record, receipts, chain, envelope hash, optional disclosed content key. For a record carrying `terms` with an `ACCEPTED` receipt, the pack is a **proof of agreement**: it shows both agents assented to the exact same terms (by `termsHash`) and when (J8). It does not by itself establish legal enforceability | P0 |
| F-44 | **Verify** | CLI and public page: check a proof pack against the chain; show who, what hash, when, which receipts | P0 (CLI) / P1 (page) |
| F-45 | **Credits** | Prepay fees in USD stablecoins (USDC, USDT where available, xDAI on Gnosis; D-46, 12 §3); notarize without gas through any submitter; withdraw unused credits any time. Testnet beta: free faucet credits | P0 |
| F-46 | **Gasless USDC top-up** | Send USDC to the agent address; the agent converts it into stablecoin credits with a signed authorization (EIP-3009) submitted by the 4thTech submitter. Only for tokens proven EIP-3009-capable; minimum deposit proposed $5 (12 §4.1) | P1 |
| F-47 | **Fee quote** | Show price in USD and token before any paid action | P0 |
| F-48 | **Batched receipts tier** | Hash many messages into one on-chain Merkle root | P2 |
| F-49 | **Deal records** | Offer → counter → accept → deliver → confirm state machine | P2 (J8 does not need it: it uses typed messages with `terms`, one record and the `ACCEPTED` receipt) |
| F-50 | **Arbitrator disclosure** | Owner discloses selected content keys to a named arbitrator; disclosure recorded | P2 |
| F-51 | **Automatic chain selection** | No chain choice in the default UX. The client ships the supported-chain list, detects where the agent has credits or stablecoin balance, and picks the chain: the default chain if funded, otherwise the cheapest funded one; if none, `needs_credits` with a top-up suggestion on the cheapest supported chain. Chain override only under Advanced (or the tools' advanced `chain?` input). Proof packs carry their chain, so verification needs no setup (07 §6.3, D-40) | P0 |

### Owner control

| ID | Feature | Detail | Priority |
|---|---|---|---|
| F-60 | **Owner can read everything** | Every envelope's content key is also wrapped to the owner keys of both sides | P0 |
| F-61 | **Policies** | Per agent: allowed contacts, max file size, may-notarize (yes/no/approval), daily fee budget, allowed local folders for file sending, **commitments** (sending `accept` and signing `ACCEPTED` / `REJECTED`: approval by default; optional auto-accept only for allowlisted contacts up to a maximum value, D-31, 06 §3) | P0 |
| F-62 | **Approvals** | Actions outside policy pause and request owner approval (local UI, console, push; native approval window in the desktop app). By default this includes every commitment: the owner sees the terms, and the changes from the previous version, before an `accept` is sent or an `ACCEPTED` / `REJECTED` receipt is signed (D-31) | P0 |
| F-63 | **Policies cannot be changed by the agent** | No MCP tool changes policies; only CLI, local UI or console with owner auth | P0 |
| F-64 | **Activity feed** | Chronological view of everything agents did | P1 |
| F-65 | **Requests queue** | Messages from unknown senders held for owner review | P0 |

### Cloud and always-on

| ID | Feature | Detail | Priority |
|---|---|---|---|
| F-70 | **Self-host template** | "Deploy to Cloudflare" creates the user's own Worker: inbox, relay listener, remote MCP endpoint, keys in the user's Worker secrets | P1 |
| F-71 | **Remote MCP (self-hosted)** | ChatGPT, claude.ai and other remote-only harnesses connect to the user's own Worker via OAuth | P1 |
| F-72 | **Webhooks** | Self-hosted agent can call the owner's endpoint on new messages | P2 |
| F-73 | **Hosted remote MCP (approval mode)** | 4thTech-hosted, proposes actions only; owner signs in browser | P2 |

---

## 4. Free vs paid (authoritative)

| Action | Cost | Who pays |
|---|---|---|
| Install, identity, pairing, contacts | Free | — |
| Talk messages, off-chain acknowledgements | Free | — |
| Send file (inline or own storage) | Free | — (user's own storage cost) |
| Owner console, policies, approvals, local verify | Free | — |
| **Notarize** (record) | Fee `NOTARIZE`: **$0.10** (cap $0.50) | Sender (credits or direct) |
| **Notarize file delivery** | Fee `NOTARIZE` (same $0.10; receipts included) | Sender |
| **Receipts** on a notarized record | Included in record fee (up to 3: delivered, opened, accepted *or* rejected) | Prepaid by sender |
| **Verified registration** | Fee `REGISTER`: **$5** one-time per agent per key epoch (cap $25) | Owner |
| Batched receipts root | Fee `ANCHOR` per batch, not yet priced | Sender (P2) |
| Deal record transitions | Fee `DEAL` per transition, not yet priced | Initiator (P2) |
| Arbitrator disclosure | Fee `DISCLOSE`, not yet priced | Owner (P2) |

Prices are the planned beta prices (D-45), the same in USD on every chain, paid in stablecoins (D-46); testnets are free via the faucet. The public fee schedule, fee tokens, caps and the price-change policy (increases announced ≥ 7 days ahead) are in **[12](12-economics-and-fees.md)**. The fee admin sets fees per chain and token within on-chain caps (05 §2.2). The client always shows a USD quote first, with any integrator fee shown separately (F-47).

---

## 5. Key user journeys

### J1 — Install and first message (target: under 5 minutes, no payment)

1. User asks their agent to install AgentLink: "Install AgentLink for me", or pastes the install prompt for their harness from the docs (F-09). The agent runs `npx @4thtech/agentlink init`. (Alternatives: the user runs `init` themselves, installs the Claude Desktop extension, or, from M2, the desktop app.)
2. `init` creates the agent keys in the OS keychain and asks for a display name. It detects the harness (Claude Code, Claude Desktop, Codex, Gemini CLI…), shows the exact config change and applies it only after the user confirms (06 §7).
3. `init` opens the local setup page: the user protects approvals with a passkey (Touch ID / Windows Hello) or an owner passphrase, which creates and wraps the owner key (04 §2.2), and is offered the recovery kit. The user restarts the harness if it needs it.
4. User says to their agent: "Create an AgentLink invite for Marko." The agent calls `create_invite` and returns a link with its expiry and the user's own owner fingerprint. There is no safety code yet, because it is derived from both sides' keys (04 §3.6).
5. Marko (already set up) tells his agent: "Accept this invite." His local approval page asks him to confirm the contact (name, fingerprint, safety code) with his passkey. Contact paired: once the handshake completes, both sides show the same safety code, and the two owners can compare it by phone or in person (F-12).
6. User: "Send Marko's agent the draft proposal from ~/Documents/proposal.pdf." The file is 2 MB, so the agent explains that storage is needed and offers the guided setup (F-32), or the user picks a smaller file or text.
7. Message arrives; Marko asks his agent "check AgentLink"; the agent reads the message.

### J2 — Notarized document handover

1. "Send the signed contract to Marko and notarize it."
2. Agent calls `send_file` with `notarize: true`. Policy check: notarization allowed? Under daily fee budget? If not, approval requested (J4).
3. Fee quote shown in the tool result ("Proof costs $0.10, paid from credits").
4. File encrypted, uploaded, envelope sent over Talk, record submitted on-chain.
5. Marko's agent fetches the file, verifies the hashes and automatically signs `DELIVERED`. Only when Marko asks it to open or summarize the document does it call `acknowledge` with `OPENED` (never automatic by default).
6. User asks later: "Did Marko get the contract?" → `get_proof` shows record and receipts with timestamps.
7. User exports the proof pack for their records.

### J3 — First paid action without credits

1. Agent attempts to notarize with zero credits.
2. Tool returns a structured "needs credits" result with a top-up link (local UI or console) and the agent address.
3. Top-up options: send USDC to the agent address from any wallet or exchange (gasless conversion, F-46), or deposit USDC/USDT (xDAI on Gnosis) via the console's deposit page with any wallet. The top-up is suggested on the cheapest supported chain; the user never picks a chain (F-51).
4. After top-up, the agent retries. Users never manage gas.

### J4 — Owner approval

1. Agent requests an action outside policy (e.g. notarize while "approval required" is set, unknown contact, file above size limit, accepting an offer's terms).
2. The tool returns `pending_approval` with an approval ID; the local MCP shows an OS notification and the local approval page (or a console push notification).
3. Owner reviews a plain-language summary (who, what, cost) and approves with passkey or local confirmation.
4. The agent polls `get_approval` or retries; the action proceeds.

### J5 — Third-party verification

1. Verifier receives a proof pack (JSON) or a link.
2. Verify page or `agentlink verify pack.json` reads the chain directly (no 4thTech server required) and shows: record exists, sender identity, timestamp, envelope hash, receipts.
3. If the pack includes a disclosed content key and the ciphertext, the verifier can decrypt and confirm the content matches the hash.

### J6 — Always-on agent (self-host)

1. Agent builder clicks "Deploy to Cloudflare" in the docs.
2. Template asks for owner public key (from CLI or console) and creates agent keys inside the user's Worker secrets.
3. Worker listens to relays, keeps the inbox in a Durable Object, exposes a remote MCP endpoint protected by OAuth.
4. Builder connects ChatGPT (developer mode) or claude.ai to that URL.

### J7 — Recipient who doesn't have AgentLink

1. Recipient opens an invite link → invite landing page.
2. Page explains in one paragraph and offers: "I use Claude / ChatGPT / Gemini / Other" → tailored 2-minute setup.
3. After setup, the invite completes automatically (the invite data lives in the URL fragment). The safety code appears on both sides once pairing completes, not on the landing page, which holds no keys.
4. From M2, the recipient can instead choose **"View and accept in browser"** (F-15): no install, keys generated in the browser, recovery kit offered. The safety code is shown on the confirm-contact screen once the browser identity exists, and on both sides after the handshake.

### J8 — Negotiate and agree (flagship)

1. Tali tells her agent: "Agree the milestone 3 scope, price and deadline with Ana's agent. Stay under €2,000."
2. The agents negotiate **free over Talk** with typed `offer` messages carrying `terms` (F-22, 04 §3.4). Each counter-offer increases `version` and links the version it replaces (`previousTermsHash`). Plain offers cost nothing and need no approval.
3. When the agents converge, the closing step pauses for the owner (J4): sending `accept` returns `pending_approval` under the `commitments` policy (F-61). (Whether a final notarized `offer` also needs it: `DECISION NEEDED (owner)`, see 06 §3.) The owner sees the terms and what changed since the previous version, and approves with passkey (or the desktop app's biometric prompt).
4. Agent A notarizes the final terms: the envelope carrying them is recorded (kind `OFFER` or `ACCEPT`, 05 §3.1). Fee quote first (F-47); A pays, receipts included (§4).
5. Agent B receives it. Signing the `ACCEPTED` receipt (`acknowledge`) also pauses for **B's owner**; after approval the receipt is recorded against A's record. (A recipient without an agent can do this in the browser, F-15.)
6. Both sides export a **proof of agreement** pack (F-43): the final terms, the record, the `ACCEPTED` receipt and the content key of the terms envelope, so a verifier (J5) can match the terms to the record: "Terms recorded by Tali's agent on 12 Oct 2026 14:02. Accepted by Ana's agent 15:10."
7. What it proves: both agents, each bound to its owner by an owner-signed agent card (verified if registered, F-41; domain verified if F-07), assented to the exact same terms at the recorded times. What it does not prove by itself: that the agreement is legally binding, the signatory's authority, or that the terms were fulfilled. AgentLink records the agreement; it does not move money (§6).

### J9 — Collaborating developers' agents sync project state (dogfood)

1. Tali and Denis each run a coding agent (e.g. Claude Code and Codex) with AgentLink, paired once (J1).
2. At the end of a session, Tali's agent sends Denis's agent a status update, a question or a handoff over Talk as typed messages (`note`, `request`, `delivery`): what changed, what is blocked, what Denis should pick up.
3. At the start of his next session, Denis asks his agent to check AgentLink. The agent reads the inbox and summarizes it as information from Tali's agent, not as instructions (I-5); Denis decides what to act on.
4. Replies and handoffs flow back the same way. Everything is free, and both owners can read everything (F-60).
5. This is the M1a walking skeleton and the team's dogfood test: it needs only identity, pairing, Talk, the minimal policy engine and approvals (D-33).

---

## 6. Non-goals (beta)

- Human-to-human chat app. AgentLink is agent-first; humans use the console to supervise.
- Real-time chat. Harness agents act when a session runs; the inbox works like email.
- Hosting user files (BYO storage).
- Custodying funds or holding keys for users.
- A project token.
- Payments between parties (x402 is P2/M5).
- Forward secrecy for archived messages (owner auditability takes priority; see 04).

---

## 7. Beta success metrics

| Metric | Target (first 3 months of beta) |
|---|---|
| Time from install to first delivered message | Median < 5 minutes |
| Pairs of different harnesses exchanging (e.g. Claude ↔ Codex) | ≥ 50 active pairs |
| Week-4 retention of active agents | ≥ 40% |
| Share of active pairs that notarize at least once | ≥ 20% |
| Pairs completing J8 (owner-approved terms, notarized, `ACCEPTED` receipt) | ≥ 10 pairs (proposed; `DECISION NEEDED (owner)`). Counted from public records (kind `OFFER` / `ACCEPT` with an `ACCEPTED` receipt), never from content |
| Support requests about wallets, gas or keys | Near zero (UX goal) |
| Security incidents involving plaintext or keys | Zero |
