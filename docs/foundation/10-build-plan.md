# 10 — Build Plan

Milestones are sequential gates; tasks inside a milestone can run in parallel (separate Claude Code sessions / worktrees). Durations are indicative for a small team assisted by Claude Code.

Every task ends with: tests passing in CI, docs updated, and the relevant acceptance criteria demonstrated.

---

## At a glance

We build in public, in stages, and each stage ends with something you can try. This is the map; the task tables below hold the detail. Durations are indicative, not commitments.

### The 9 building blocks

| # | Block | What it covers |
|---|---|---|
| 1 | Crypto | Keys, encryption, signatures |
| 2 | Messaging | Encrypted messages over Nostr relays |
| 3 | Core | Pairing, contacts, threads, the owner's rules and approvals |
| 4 | Local node | OS keychain and a local database |
| 5 | MCP server + CLI | How your agent (and you) use AgentLink |
| 6 | Files | Encrypted drop by default, own storage optional (D-48, D-49) |
| 7 | Proof | Contracts (OCCFeeVault, OCCNotary), chain client, submitter |
| 8 | Apps | Local approval UI, then owner console, then desktop apps for macOS, Windows and Linux |
| 9 | Cloud agent | Self-host in your own Cloudflare account |

### Stages

| Stage | What you can do at the end | Blocks | Duration | Version |
|---|---|---|---|---|
| **M0** | Repo, CI and rules are in place | none (foundations) | ~1 week | 0.0.x |
| **M1a** | Two agents pair and chat. The J9 dogfood: Tali's and Denis's agents sync this project through AgentLink | 1–5 | ~2–3 weeks | 0.1.0 |
| **M1b** | Send files and get proof on testnets; 10 internal testers | 6, 7, local UI of 8 | ~3–4 weeks | 0.2.0 |
| **M2** | Console, desktop apps, cloud agent, verify and invite pages, verified domains, storage connectors; 20–50 external testers | 8, 9, 6, 7 | ~4–6+ weeks | 0.3.0 |
| **M3** | External audit, then mainnet on Base and Gnosis | 7 | ~4 weeks | 1.0.0 |
| **M4/M5** | More chains, batching, finance dashboard, then deals and payments | 7, 8 | rolling | after 1.0.0 |

### External services by stage

What and when only. Cost estimates are tracked internally.

| When | Services |
|---|---|
| Now (free tiers) | GitHub, npm, public Nostr relays, testnet faucets, public RPCs |
| M1b | Cloudflare Workers Paid, R2 for the drop, an RPC provider |
| M2 | Apple Developer ID, Windows code signing, OAuth app registrations (Google, Dropbox, Microsoft), the production domain after the trademark check |
| M3 | Hardware wallets for Safe signers, an external audit firm, legal counsel, mainnet gas |

---

## M0 — Foundations (≈ 1 week)

| Task | Output | Acceptance |
|---|---|---|
| M0-1 Legacy security actions L-1, L-5, L-8 (details in private 09 §4) | Remediation per item (tracked privately); gitleaks report | Written confirmation per item |
| M0-2 Create repos (09 §5), branch protection, CI (lint, typecheck, test), Renovate, npm org with 2FA | Empty monorepo + contracts repo | CI green on skeleton |
| M0-3 Copy this pack to `docs/foundation/`, add `CLAUDE.md` | Docs in repo | — |
| M0-4 Decide D-11, D-12, D-14 (license, name) | Decision log updated | — |

## Design deliveries (owner, via Claude Design — D-30)

Design is delivered by the owner in three drops so it never blocks the build. The brief for designers is `11-claude-design-brief.md`. Intake and live status are in `docs/design/README.md`. Until a surface's design has landed, agents build it **functional and unstyled** (semantic HTML, placeholder tokens) and never invent a visual design for it.

| Drop | Contents (11 §) | Needed by | Blocks |
|---|---|---|---|
| **D1: brand core and M1 surfaces** | Brand core: mark, wordmark, lockups, favicon and AI-app listing icon (2, D-56); in-chat copy sheet (6.1, the highest priority) and terminal copy (6.10); design tokens (11.7) and core components (8); local settings and approvals app (6.2.1) with its states (9); a simple "how to install" invite placeholder page | **Week 3 of M1** | Nothing hard. M1a comes first, so the copy sheet feeds the M1a tool summaries (M1-9); tokens and the approvals app feed the M1b local UI (M1-11). Until it lands they stay unstyled and use the 11 §5 vocabulary; the M1a gate does not wait for it |
| **D2: full system and M2 surfaces** | The complete component library; OS app icons, tray icons and PWA icons (2.4); desktop apps for macOS, Windows and Linux (6.2.2); cloud agent pages (6.9); storage, proofs and printed records, registration and domain verification (6.11–6.13); owner console (6.3, desktop and mobile), whose screens are also the desktop dashboard (D-41); verify page (6.4); invite landing (6.5) and browser counterparty view-and-accept (D-35); onboarding (6.6); pay page (6.7) and pricing (6.8); clickable prototypes J1, J2, J4, J5, J8; rationale notes (13) | **Before the M1 gate** | M2-1, then M2-2 (incl. the pay page, M2-2f), M2-5, M2-6, M2-11 (dashboard) and M2-13 |
| **D3: launch brand** | Brand final after the trademark check, the marketing site (6.15) and social images (out of scope for beta per 11 §15) | Before public launch (M3) | M3 public launch only |

## Owner tasks with long lead times

| Task | When | Why |
|---|---|---|
| Product name and trademark check (D-38) | During M1 (start early) | Must precede the production-domain choice (M2-10): owner passkeys bind to that domain |
| Apple Developer ID (organisation) and a Windows code-signing certificate (D-36) | Start in M1b; needed in M2 | Enrolment and validation take weeks; the desktop signing pipeline (M2-11) needs them |
| Encrypted drop: R2 bucket, lifecycle rule and `drop.` hostname; counsel review of the hosting terms, terms of service and takedown process (D-48) | Start in M1a; needed before the drop goes live in M1b | The drop (M1-27) cannot serve testers without the bucket, and the terms need counsel |
| OAuth client registration and app review with Google, Dropbox and Microsoft (D-49) | Start in M1b; needed in M2 | Provider app reviews and verification take weeks; the connectors (M2-15) need them |

## M1 — Local beta on testnets (≈ 5–7 weeks, in two phases)

**Goal:** two people on different harnesses exchange messages and files and notarize on testnets, with no wallet and no payment for free features.

**Walking skeleton first (D-33).** M1 runs as **M1a**, which proves identity, pairing and Talk end to end between two harnesses, then **M1b**, which adds files, proof and credits. Task IDs are unchanged; a task that spans both phases appears in both tables with the part that belongs to each, and the backlog cards carry the exact split (`**Phase:**` on every M1 card). Crypto, the policy engine and anything that signs stay tests-first in both phases. M1b lanes with long lead times (contracts, proof-layer vectors, chain configuration) start in parallel during M1a.

### M1a — Walking skeleton: pair and talk

| Task | Package | Acceptance |
|---|---|---|
| M1-1 `@agentlink/crypto` (Talk part) | crypto | Test vectors for key derivation (HKDF), BIP-340 envelope signatures, HPKE CEK wrap and payload AEAD, envelope hash via JCS, owner passphrase wrapping, pairing proof, safety code and the `AgentCard` EIP-712 hash pass in Node, browser (Playwright) and Workers (Miniflare); NIP-44 v2 and NIP-59 via `nostr-tools` |
| M1-2 `@agentlink/types` + zod schemas | types | Envelope, payload (incl. typed `offer`/`accept`/`reject` with the `terms` schema and `termsHash` vectors, D-32), policy (incl. `commitments`, D-31) and proof-pack schemas with round-trip tests |
| M1-5 `@agentlink/transport-nostr` | transport | Gift wrap/unwrap interoperable with `nostr-tools` reference; publish to ≥ 2 relays; sync with cursor + dedup; size limits |
| M1-7 `@agentlink/core` (Talk part) | core | Identity, invites and pairing, contacts, envelopes, inbox sync; a minimal policy engine with approvals, including the `commitments` policy (D-31: a binding `accept` needs owner approval by default; owners may allow auto-accept within limits); unit-tested per rule |
| M1-8 `@agentlink/node` (Talk part) | node | Keychain KeyStore on macOS/Windows/Linux; SQLite store with encrypted sensitive columns; OwnerKeyStore unlocked by the owner passphrase at a CLI prompt (the M1a minimum for owner presence); owner-signed policies verified on load. Test: a script running as the same OS user cannot approve or change policy |
| M1-9 CLI + MCP server (Talk part) | apps/cli | `init` with harness detection, the exact config diff and confirmation; `invite`, `accept`, `contacts`, `approve`/`deny`, `policy`; MCP tools `agentlink_status`, `create_invite`, `accept_invite`, `list_contacts`, `send_message` (incl. typed offer/accept/reject with `terms`), `check_inbox`, `get_thread`, `get_approval`; MCP Inspector validation; tool summaries follow the D1 copy sheet once it lands |
| M1-12 Skill file + install docs (Talk part) | skills/, docs | Agent-assisted install (D-39): with a documented prompt, a fresh user's own agent installs AgentLink in under 5 minutes on Claude Code, Codex and Gemini CLI; Talk and negotiation workflows; harness permission guidance |
| M1-13 E2E (Talk part) | e2e | Agent A (Claude Code headless) ↔ agent B (Codex): pair and message; J8 negotiation over Talk (offer, counter-offer, binding accept after owner approval); prompt-injection suite on the Talk tools |

**Gate M1a:** Tali's and Denis's agents pair and sync project status through AgentLink (J9 dogfood), and complete a J8 negotiation over Talk without on-chain proof. No milestone audit at M1a; per-task reviews apply.

### M1b — Files, proof, credits

| Task | Package | Acceptance |
|---|---|---|
| M1-1 `@agentlink/crypto` (rest) | crypto | Test vectors for STREAM file encryption, EIP-712 (`Record`, `Receipt`, `Registration`) with commitments, passkey PRF wrapping and the recovery code pass in all three runtimes |
| M1-3 Contracts: OCCFeeVault + OCCNotary | contracts | Full unit/fuzz/invariant suite (incl. ERC-1271 signers); gas targets met; Slither/Aderyn clean; deployed to Base Sepolia + Gnosis Chiado via CreateX (CREATE3) with identical addresses |
| M1-4 `@agentlink/chain` | chain | EIP-712 parity with contract test vectors; quote, notarize (direct + submitter), acknowledge, verifyProofPack against testnets; zero-config chain selection (D-40): the client ships the chain list, picks the default chain if funded, otherwise the cheapest funded one, and never asks for a chain outside Advanced |
| M1-6 `@agentlink/storage` (inline + encrypted drop + S3 via aws4fetch) | storage | Upload/presign/download/delete against R2 and MinIO; streaming 1 GB file without loading into memory; `drop` adapter against the drop Worker (signed upload, signed GET, signed delete); storage selection per 07 §5.6 (D-48) |
| M1-27 Encrypted drop Worker + R2 (D-48) | apps/drop | Signed uploads verified against test vectors; random 128-bit object keys; size cap and weekly quota per drop key, rate limits per drop key and per IP; hard 7-day expiry (Worker check plus R2 lifecycle rule); DELETE only by the uploading drop key; objects served only as attachments; no request URLs, signed URLs, object keys or upload signatures in any log (asserted in tests); deployed to `drop.agentlink.4thtech.io` |
| M1-7 `@agentlink/core` (rest) | core | Files, proofs and receipts; policy rules for files, proofs and receipts; proof of agreement (D-32): notarized final terms plus the counterparty's ACCEPTED receipt, which falls under `commitments` |
| M1-8 `@agentlink/node` (rest) | node | OwnerKeyStore unlocked by a localhost passkey (PRF) as well; local approval server (in-memory token, host/origin checks) |
| M1-9 CLI + MCP server (rest) | apps/cli | File and proof tools from 06; `storage connect` (optional), `backup`, `credits`, `verify`, `ui`; Claude Desktop one-click extension |
| M1-10 Submitter (testnets) + credits faucet | apps/submitter | Simulates, submits, batches; rate limits; health endpoint; faucet endpoint calls `depositFor` with testnet credits (rate-limited per agent) |
| M1-11 Local approval UI (functional and unstyled; styled from D1 when it lands) | apps/cli | Owner passkey setup, approvals with passkey, storage (drop usage; optional own storage), allowed folders, policies, credits (faucet on testnet), backup |
| M1-12 Skill file + quickstart docs (rest) | skills/, docs | A new user completes J1 from docs alone |
| M1-13 E2E suite (rest) | e2e | 5 MB file with zero storage setup (encrypted drop), notarize, DELIVERED/OPENED, export + verify pack; J8 with on-chain proof of agreement; prompt-injection suite on file and proof tools (06 §9) |

**Gate M1:** 10 internal testers on ≥ 3 harness combinations complete J1, J2, J4, J5 on testnets, and J3 using faucet credits; J8 completed with on-chain proof of agreement. In J1 a file over 12 KB (5 MB in the e2e suite) is sent with zero storage setup through the encrypted drop (D-48). UX (D-39, D-40): no wallet, browser extension, gas or chain choice appears in any J1–J9 default flow, and install → first message stays under 5 minutes.

## M2 — Owner console, desktop apps, self-host, design (≈ 4–6 weeks; desktop apps add scope, re-estimated in M2-11)

| Task | Output | Acceptance |
|---|---|---|
| M2-1 Design system + screens from Claude Design D2 (11) → `packages/ui` (needs D2) | Components | Matches design; accessibility AA |
| M2-2 Owner console PWA | apps/console | Passkey + PRF identity, backup to relays, new-device restore, owner link from CLI; activity, threads, approvals, policies (owner-signed envelopes), proofs, credits |
| M2-3 Cloud agent template | apps/cloud-agent | `agentlink cloud deploy` and Deploy button both work; DO inbox; remote MCP + OAuth; ChatGPT developer-mode connector and claude.ai connector tested |
| M2-4 OCCRegistry + verified badge | contracts, chain, console | Register/revoke on testnets; badge shown in contacts |
| M2-5 Verify page + invite landing | apps/verify, apps/invite | Verification fully client-side; fragment never sent (asserted in tests) |
| M2-6 Restyle local approval UI with `packages/ui` | apps/cli | — |
| M2-11 Desktop apps for macOS, Windows, Linux (D-36, D-41) | apps/desktop | First an architecture task: framework choice (e.g. Tauri with a Node sidecar vs Electron), Opus, with a security review. Then per-OS builds on the same core: a tray app hosting the MCP server, a native approval window with OS biometrics (Touch ID / Windows Hello) gating the owner key in the OS keychain, harness auto-setup, and the full local dashboard (activity, threads, contacts, approvals, proofs, credits, policies, storage, settings) from `packages/ui`. Signed and notarized; auto-update with signature verification. Needs the owner's certificates |
| M2-12 Domain verification (D-34) | contracts, chain, core, console | The owner proves control of a domain (DNS TXT or `/.well-known`); ships with OCCRegistry; clients check it themselves before showing it |
| M2-13 Browser counterparty view-and-accept (D-35, P1) | web client | A counterparty without an agent opens the invite link, views the offer and accepts in the browser; keys generated in the browser, same identity model as the console; design in D2 |
| M2-15 Consumer storage connectors (D-49, P1) | packages/storage, apps/desktop | Google Drive, Dropbox and OneDrive adapters behind the same `StorageAdapter` interface; Settings → Storage → Connect in the desktop apps with OAuth (PKCE, loopback redirect), minimal scopes and tokens only in the OS keychain; only ciphertext with random names in an app folder; time-limited share links, or the owner's decision per provider (07 §5.5); round trips against each provider |

**Gate M2:** 20–50 early adopters (external) on testnets; UX metric "install → first message < 5 min" met; no wallet, browser extension, gas or chain choice in any J1–J9 default flow, including the desktop apps and the browser counterparty (D-39).

## M3 — Mainnet beta (≈ 4 weeks, includes audit)

| Task | Acceptance |
|---|---|
| M3-1 External audit of contracts; independent review of `crypto` + `core` | All high/medium findings fixed |
| M3-2 Treasury Safes, timelocks, roles per chain; deploy to **Base + Gnosis** | Deployer holds no role (scripted check) |
| M3-3 Fee configuration (stablecoins only at launch: USDC, USDT where available, xDAI on Gnosis; D-46) and pricing for beta | `fee_quote` shows USD with the protocol and integrator split |
| M3-4 Credits UX: `depositFor` page, gasless USDC (EIP-3009) | J3 completed without gas |
| M3-5 Submitter mainnet with gas monitoring and alerts | — |
| M3-6 Publish verified contract source (BUSL-1.1) + addresses | Explorers verified |
| M3-7 Legal review of terms and positioning (entity jurisdiction) | Sign-off before public launch |
| M3-16 Monthly revenue report from on-chain events (D-50) | CSV per chain from `Charged`, `Deposited`, `Withdrawn` and `Swept`; totals reconcile with the treasury Safe and explorers |

**Gate M3:** first paid notarizations; zero security incidents.

## M4 — Expansion (rolling)

Arbitrum, Optimism, Polygon deployments · native-coin fees behind a bounded `PRICE_UPDATER` role, if the owner decides to offer them (D-46, 12 §3.4) · batched receipts (OCCAnchor) · ERC-8004 bridge · hosted remote MCP in approval mode (P2, after design review; self-host stays the default cloud path, D-37) · eIDAS qualified e-signature research for legal weight (D-34) · IPFS pinning adapter · XMTP transport adapter · ElizaOS plugin rewrite on `@agentlink/core` · group threads · internal finance dashboard and opt-in billing profiles for invoicing (`agentlink-ops`, D-50).

## M5 — Agent commerce

OCCDeals state machine · x402 settlement linkage · arbitrator disclosure · per-relationship agent keys.

---

## Working rules for Claude Code sessions

1. **One task per session/worktree**, referencing its ID (e.g. `M1-5`) in the branch name and PR title.
2. Read `CLAUDE.md`, `04-security-and-crypto.md` and the spec for the component before writing code.
3. Write tests first for crypto, policy engine and contracts.
4. Never weaken an invariant (I-1…I-10) to make a test pass; stop and flag instead.
5. Cross-package interfaces change only through a PR that updates the relevant spec document.
6. Every PR description lists: spec sections implemented, invariants touched, tests added, open questions.
7. Security-sensitive PRs (crypto, keys, policies, contracts, submitter) need a human reviewer plus a separate review session that has not seen the implementation.
