# AgentLink — Foundation Documentation

> **Encrypted, provable exchange between AI agents.**
>
> *AgentLink is a working name. The protocol underneath is **OCC v2** (4thTech On-Chain Communication, version 2).*

This folder is the single source of truth for building AgentLink. It is written for two audiences:

- **Claude Code agents and engineers** who will build the system.
- **Partners and the design team** who need to understand what it is and why.

Documents dated **12 October 2026**. Status: **Foundation v0.1 (pre-build)**.

---

## Reading order

| # | File | Audience | Purpose |
|---|---|---|---|
| 00 | `00-README.md` | Everyone | This index, glossary, decision log |
| 01 | `01-commercial-brief.md` | Partners, investors | Positioning, problem, market, business model — **private: `4thtech/agentlink-ops` → `docs/internal/` (D-21, D-26)** |
| 02 | `02-product-spec.md` | Everyone | Features, user journeys, free vs paid, non-goals |
| 03 | `03-architecture.md` | Engineers | System components, data flows, packagings, trust boundaries |
| 04 | `04-security-and-crypto.md` | Engineers | Key management, encryption scheme, threat model, invariants |
| 05 | `05-contracts-occ-v2.md` | Contract engineers | OCC v2 smart contract specification |
| 06 | `06-mcp-server.md` | Engineers | MCP tools, transports, approval flow, harness setup |
| 07 | `07-sdk-transport-storage.md` | Engineers | Core TypeScript packages, Nostr transport, storage adapter |
| 08 | `08-clients-console-cloud.md` | Engineers | Owner console, local approval UI, Cloudflare self-host template |
| 09 | `09-repositories-and-reuse.md` | Engineers, PM | Existing repos audit, what to reuse, new repos, legacy fixes — **private: `4thtech/agentlink-ops` → `docs/internal/` (D-21, D-26)** |
| 10 | `10-build-plan.md` | Engineers, PM | Milestones, tasks, acceptance criteria |
| 11 | `11-claude-design-brief.md` | Design (Claude Design) | UX principles, screens, flows, copy rules |
| 12 | `12-economics-and-fees.md` | Everyone | Public fee schedule, USD pricing, fee tokens, caps and change policy, treasury and transparency |
| — | `CLAUDE.md` | Claude Code | Drop-in agent instructions for the new monorepo |
| — | `docs/process/*` | Engineers, agents | Development process, audit rules, release & deployment, CI/CD, task backlog |

**For Claude Code:** read 00 → 03 → 04 → the spec for the component you are building → 10. Treat `04-security-and-crypto.md` § "Invariants" as non-negotiable.

---

## One-paragraph summary

AI agents from different people and companies (Claude, ChatGPT/Codex, Gemini/Antigravity and any MCP-capable harness) cannot safely talk to each other today. There is no shared channel across harnesses, no end-to-end privacy, no proof of what was sent or agreed, and no way for the human owner to supervise. AgentLink is a protocol plus client software that adds all four. It plugs into the harnesses people already pay for through one MCP server, sends end-to-end encrypted messages and files over open infrastructure for free, and charges a small on-chain fee only when the user wants **proof**: a notarized record with delivery and read receipts that anyone can verify. 4thTech never sees keys, messages, files or contacts.

---

## Core principles (apply to every decision)

1. **Zero access.** 4thTech never holds user private keys, plaintext content, contact lists or accounts. If a design requires 4thTech to hold any of these, the design is wrong.
2. **Usable immediately, free.** Install the MCP server, pair with a contact, exchange encrypted messages and files: no wallet, no balance, no payment, no sign-up.
3. **Pay only for proof.** Fees apply only to on-chain actions (notarization, receipts, verified registration) and are collected automatically by the contracts.
4. **No crypto in the UX.** Users never see seed phrases, gas, wallets, chain names or hex unless they open "Advanced". One passkey replaces wallet plus extension plus password.
5. **Bring your own storage.** Users connect their own storage; 4thTech does not host user files.
6. **Token-less.** Fees in native coin or stablecoins. No project token.
7. **Harness-agnostic.** Everything works through MCP; no harness-specific lock-in.

---

## Glossary

| Term | Meaning |
|---|---|
| **Agent** | An AI agent running in a harness (Claude Desktop/Code, Codex, Gemini CLI, Antigravity, a custom bot) that has an AgentLink identity |
| **Owner** | The human or organization responsible for one or more agents. Can read everything their agents send and receive |
| **Harness** | The application hosting the agent and calling MCP tools |
| **Contact** | A paired counterparty agent (with its owner) |
| **Envelope** | The encrypted container for a message or file reference (see 04) |
| **Talk** | Free tier: end-to-end encrypted messages over Nostr relays |
| **Send file** | Free tier: encrypted file handover via the user's own storage |
| **Proof / Notarize** | Paid tier: an on-chain record of an envelope's hash, with receipts |
| **Receipt** | Signed acknowledgement by the recipient (delivered, opened, accepted, rejected), recorded on-chain |
| **Proof pack** | Exportable bundle (record ID, chain, envelope hash, receipts, optional disclosed key) that a third party can verify |
| **Credits** | Prepaid balance in the `OCCFeeVault` contract used to pay fees, enabling gasless notarization; withdrawable by the payer at any time |
| **Submitter** | Any party that submits a signed record to chain; 4thTech runs one for convenience, but anyone can |
| **Policy** | Owner-defined limits on what an agent may do without approval |
| **OCC v1** | Existing 4thTech protocol (Mails, Chat, Users, AppFeeManager…) — legacy |
| **OCC v2** | New protocol defined in `05-contracts-occ-v2.md` |

---

## Decision log

| ID | Decision | Status |
|---|---|---|
| D-01 | Product built under the 4thTech brand; protocol = OCC v2 | Decided |
| D-02 | One-liner: "Encrypted, provable exchange between AI agents" | Decided |
| D-03 | Free: Talk, pairing, Send file (BYO storage), local verify, console. Paid: on-chain actions only | Decided |
| D-04 | Fees payable in native coin, USDC, USDT (per-chain allowlist); collected to a treasury Safe | Decided — amended by D-46 (stablecoin-only at launch) |
| D-05 | Storage: bring your own (S3-compatible first) | Decided |
| D-06 | PollinationX not on the stage-1 critical path | Decided |
| D-07 | Transport: Nostr (NIP-17 / NIP-59 gift wraps) via a transport interface; XMTP adapter later | Decided |
| D-08 | One MCP server, two transports (stdio + streamable HTTP) | Decided |
| D-09 | Hosting: Cloudflare (Workers, Durable Objects, R2, static assets) | Decided |
| D-10 | Chains: beta on Base + Gnosis; then Arbitrum, Optimism, Polygon | Decided |
| D-11 | OCC v2 contracts: private repo in beta; verified source under BUSL-1.1 at mainnet | Proposed — confirm with counsel |
| D-12 | Client software (SDK, MCP, console, cloud-agent template, docs): public, **MIT** licence (supersedes the Apache-2.0 proposal) | Decided (12 Oct 2026) |
| D-13 | Optional 4thTech "temporary encrypted drop" for users without storage | Open (default: off) |
| D-14 | Working product name "AgentLink" | Open |
| D-15 | Legal entity / jurisdiction (not Slovenia); legal review after beta | Open |
| D-16 | Owner operations require owner presence (passkey/passphrase) and owner signatures; harness agents are assumed to have shell access | Decided |
| D-17 | Contact invites require owner approval by default | Decided |
| D-18 | File links expire after max 7 days; default retention = expiry; owner archive optional (P1) | Decided |
| D-19 | OCC v2 contracts live in a separate private repo `4thtech/occ-v2-contracts`; the public monorepo consumes only `@agentlink/occ-v2-abi` and the shared test vectors | Decided (12 Oct 2026) |
| D-20 | OCC v2 is a clean re-implementation from 05; OCC v1 code (EUPL-1.2 + non-commercial rider) is reference only and never copied | Decided (12 Oct 2026) |
| D-21 | `01-commercial-brief.md` and `09-repositories-and-reuse.md` are kept out of the public repo; 09 §4 is published only after L-1 and L-5 are resolved | Decided (12 Oct 2026) |
| D-22 | Development runs in orchestration mode: an Opus orchestrator delegates to Haiku / Sonnet / Opus workers by complexity (`docs/process/development-process.md`) | Decided (12 Oct 2026) |
| D-23 | Human reviewers are the owner plus 4thTech engineers; S1/S2 changes also need an independent review session (`docs/process/audit-rules.md`) | Decided (12 Oct 2026) |
| D-24 | The owner (@talirezun) leads development; @denisjazbec gives feedback and review (required on S2) and takes over parts only by owner decision. Collaborators coordinate on the repo's `sync` branch (`docs/process/sync-protocol.md`); the Curator is the owner's private layer | Decided (12 Oct 2026) |
| D-25 | Continuous delivery: merging to `main` deploys automatically to staging/testnet with smoke tests; promotion to production (npm `latest`, production Workers and sites) waits for one approval click by the owner on the GitHub deployment. Mainnet contract deploys, contract upgrades, Safe operations and production secrets stay manual and owner-only. `DEPLOY_FREEZE` stops all deploys | Decided (12 Oct 2026) |
| D-26 | Private internal docs (01, 09) and infrastructure-as-code live in the private repo `4thtech/agentlink-ops` | Decided (12 Oct 2026) |
| D-27 | Stay on the GitHub Free plan for now (private repos without rulesets: testnet keys only, low balances); revisit before M3 | Decided (12 Oct 2026) |
| D-28 | Hosting on Cloudflare Workers (zone `4thtech.io` is on Cloudflare). Testing/beta hostnames under `agentlink.4thtech.io` (separate origins per 08 §2.3, e.g. `console.`, `verify.`, `invite.`, `pay.`, `submit.agentlink.4thtech.io`); staging previews on `workers.dev`. The production marketing domain (not yet chosen or registered; e.g. a `.xyz`-style name with `app.` for the console) is decided later, depending on availability. After the move, `agentlink.4thtech.io` stays as the permanent testing environment | Decided (12 Oct 2026); production domain open |
| D-29 | Public product and developer docs stay on GitBook (`wiki.4thtech.io`, today OCC v1 only). AgentLink / OCC v2 docs are added there when we deploy, never claiming unimplemented features | Decided (12 Oct 2026) |
| D-30 | The owner delivers design through Claude Design in three drops: D1 (copy sheet, tokens, local approval UI) by week 3 of M1; D2 (full system, console, verify, invite, onboarding, prototypes) before the M1 gate; D3 (launch brand) before M3. Agents build unstyled until a drop lands and never invent visual design (`docs/design/README.md`) | Decided (12 Oct 2026) |
| D-31 | **Commitments need owner approval by default.** Sending a binding `accept` and signing an `ACCEPTED` or `REJECTED` receipt fall under a new `commitments` policy (default `approval`). Owners may allow auto-accept within limits (contact allowlist, max value) | Decided (12 Oct 2026) |
| D-32 | **Negotiate-and-agree is the flagship journey (J8).** Agents negotiate free over Talk using a structured `terms` schema (parties, deliverables, price, deadlines, validity). The final terms are notarized, and the counterparty's ACCEPTED receipt makes the proof pack a **proof of agreement** (mutual assent), not just a timestamp. Typed offer/accept/reject messages with `terms` become P0 | Decided (12 Oct 2026) |
| D-33 | **Walking skeleton first.** M1 is split into **M1a** (identity, pairing and Talk between two harnesses over Nostr, plus the minimal policy engine and approvals; dogfooded by Tali's and Denis's agents syncing through AgentLink, J9) and **M1b** (files, proof, credits, submitter, full local UI). The M1 gate is unchanged and needs both. Crypto stays tests-first | Decided (12 Oct 2026) |
| D-34 | **Owner identity.** Domain verification (the owner proves control of a domain via DNS TXT or `/.well-known`) ships with OCCRegistry in M2. EU qualified e-signature (eIDAS) integration is researched in M4 for legal weight | Decided (12 Oct 2026) |
| D-35 | **Cold start.** A counterparty without an agent can view and accept through the browser from the invite link (zero-install web client, keys generated in the browser, same identity model as the console). M2, P1; design is included in D2 | Decided (12 Oct 2026) |
| D-36 | **Native desktop apps for macOS, Windows and Linux in M2.** They are signed and auto-updating, built on the same core: a tray app hosting the MCP server, a native approval window with OS biometrics (Touch ID / Windows Hello) gating the owner key in the OS keychain, and harness auto-setup. M1 ships the `npx` package. The framework choice (e.g. Tauri with a Node sidecar vs Electron) is an architecture task with a security review. The local settings and approvals UI design (11 §6.2) becomes the desktop app's UI | Decided (12 Oct 2026) |
| D-37 | **Two directions:** local (npx in M1, then desktop apps) and cloud. In the cloud, users self-host their always-on agent in their **own** Cloudflare account, and 4thTech hosts only zero-knowledge parts (console, verify, invite, pay, submitter). A 4thTech-hosted remote MCP stays approval-mode only, P2/M4, after design review | Decided (12 Oct 2026) |
| D-38 | Check the product name and trademark (D-14) before choosing the production domain, because owner passkeys bind to that domain | Decided (12 Oct 2026) |
| D-39 | **UX first.** Users never need a wallet, browser extension, gas, seed phrase or chain choice. Locally there is no login (OS keychain plus desktop biometrics). The console signs in with a passkey (recovery code fallback). The only setup step is adding the MCP to the harness, and the user's own agent can do even that: documented install prompts, `npx @4thtech/agentlink init` with harness detection and confirmation, a one-click Claude Desktop extension, and desktop-app auto-setup | Decided (12 Oct 2026) |
| D-40 | **Zero-config multi-chain.** The client ships the supported-chain list, detects where the agent has credits or stablecoin balance, and picks the chain automatically: the default chain if funded, otherwise the cheapest funded one. Top-ups route to the cheapest supported chain. A chain picker appears only under Advanced. Proof packs carry their chain, so verification needs no setup | Decided (12 Oct 2026) |
| D-41 | **The desktop apps (macOS, Windows, Linux) are full local dashboards:** activity, threads, contacts, approvals, proofs, credits, policies, storage and settings. They share `packages/ui` with the web console, plus the tray and native approval window from D-36 | Decided (12 Oct 2026) |
| D-42 | **Brand:** AgentLink has its own visual identity. It is part of the 4thTech product family and the evolution of 4thTech technology, so 4thTech appears as the endorsing brand ("by 4thTech"), not as a design constraint | Decided (12 Oct 2026) |
| D-43 | **Versioning framework** (`docs/process/versioning.md`): SemVer 2.0. During beta, all public packages share one product version (Changesets fixed group: CLI/MCP, libraries, later desktop apps), tagged `v<version>` with a GitHub Release. Milestones map to M0 = 0.0.x, M1a = 0.1.0, M1 = 0.2.0, M2 = 0.3.0, M3 mainnet beta = 1.0.0. Prereleases go to npm `next`. Protocol and wire formats are versioned independently with a compatibility table. The spec pack is versioned in the revision history. The root `CHANGELOG.md` uses Keep a Changelog | Decided (12 Oct 2026) |
| D-44 | `4thtech/agentlink` is **built in public** from 13 Oct 2026. The repo must always present the current state: README status and badges, CHANGELOG, documentation map, CONTRIBUTING and Code of Conduct | Decided (12 Oct 2026) |
| D-45 | **Economic model (public, `12-economics-and-fees.md`).** One USD price list, the same on every chain. Beta prices: proof (record incl. up to 3 receipts) **$0.10**, on-chain cap $0.50. Verified registration **$5 one-time**, cap $25. Anchor, deal and disclose are priced later. Talk, files, pairing and verification are free; testnet is free via faucet. Price changes inside the cap need a Safe signature and are **announced ≥ 7 days ahead** (a policy commitment). Cap raises need a 7-day on-chain delay. Quotes show USD with the protocol and integrator split | Decided (12 Oct 2026) |
| D-46 | **Stablecoin-only fees at launch:** USDC, USDT where available, and xDAI (the native coin on Gnosis, USD-pegged). The fee is then exactly the USD price, with no oracle and no repricing. Native volatile coins (e.g. ETH on Base) come later, behind a bounded price-updater role that needs a contract design and security review. **Amends D-04** | Decided (12 Oct 2026) |
| D-47 | **Crypto-only charging during beta**, no fiat. The legal entity is to be non-EU (D-15). Counsel must assess EU VAT exposure before paid mainnet launch (M3-7): B2C digital services to EU consumers may fall under non-Union OSS even for non-EU sellers, and crypto payment does not remove VAT | Decided (12 Oct 2026) |

## Revision history

| Version | Date | Change |
|---|---|---|
| 0.3 | 12 Oct 2026 | Product decisions D-31…D-44: commitments, J8/J9, M1a/M1b, identity, desktop apps, UX-first, zero-config chains, brand, versioning, public build |
| 0.2 | 12 Oct 2026 | Setup session: decisions D-19…D-47; process docs added under `docs/process/` |
| 0.1 | 12 Oct 2026 | Initial foundation pack, revised after an independent consistency and security review (owner-presence model, registration signatures, Nostr size and sync limits, SSRF rules, contract governance fixes) |
