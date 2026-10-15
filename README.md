# AgentLink by 4thTech: encrypted, provable exchange between AI agents

[![CI](https://github.com/4thtech/agentlink/actions/workflows/ci.yml/badge.svg)](https://github.com/4thtech/agentlink/actions/workflows/ci.yml) [![Security checks](https://github.com/4thtech/agentlink/actions/workflows/security.yml/badge.svg)](https://github.com/4thtech/agentlink/actions/workflows/security.yml) [![Status: pre-alpha](https://img.shields.io/badge/status-pre--alpha-orange)](#status) [![Milestone: M0 Foundations](https://img.shields.io/badge/milestone-M0%20Foundations-blue)](#roadmap) [![Latest release](https://img.shields.io/github/v/release/4thtech/agentlink?include_prereleases&sort=semver)](https://github.com/4thtech/agentlink/releases) [![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE) [![Token-less: no project token](https://img.shields.io/badge/token--less-no%20project%20token-lightgrey)](#principles) [![Built in public](https://img.shields.io/badge/built%20in-public-brightgreen)](https://github.com/4thtech/agentlink)

AgentLink lets AI agents on different harnesses (Claude, Codex, Gemini and any MCP-capable client) exchange end-to-end encrypted messages and files, and add verifiable proof when it matters. It is client software plus a protocol. 4thTech never sees keys, message or file contents, or contacts.

*AgentLink is the product name (trademark check pending). The protocol underneath is **OCC v2** (4thTech On-Chain Communication, version 2).*

## Status

<!-- status:start -->
> **Phase:** M0 Foundations nearly complete, M1a (walking skeleton) in progress (pre-alpha) · **Version:** v0.0.1 (M0 Foundations) · **Last updated:** 2026-10-15
>
> - **M0 Foundations:** Repository, process and CI.
>   - Monorepo skeleton: pnpm workspace with Turborepo, strict CI, the Foundry skeleton in the private contracts repo, architecture boundary guards and the cross-runtime test-vector harness (M0-9).
>   - Delivery pipeline and runbooks: The automated delivery pipeline (D-52) and the runbooks.
>   - Public documentation ([#88](https://github.com/4thtech/agentlink/pull/88)): `docs-site/` (D-57), published through GitBook Git Sync, and the public knowledge base (`knowledge/` and `llms.txt`).
>   - Redacting logger (@agentlink/log): Structured logging for Node, browsers and Workers that redacts secrets by field name and value shape (M0-8).
>   - Specifications and process: The specifications (`docs/foundation`), including decisions D-53 to D-59 (D-55: dedicated terms tools, one approval per agreement, decided 14 Oct 2026), the development and audit process and a security policy.
>   - CI follow-ups (in progress): A few CI follow-ups are still open.
> - **Crypto (@agentlink/crypto):** Code merged, none of it published.
>   - Encodings, hashing, JSON canonicalisation ([#27](https://github.com/4thtech/agentlink/pull/27)): Strict canonical encodings, SHA-256 and keccak-256, tagged hashes, RFC 8785 canonicalisation.
>   - Key derivation and public identities ([#29](https://github.com/4thtech/agentlink/pull/29)): Agent keys derived from one seed; public identity bundles.
>   - Envelope encryption (in progress; [#38](https://github.com/4thtech/agentlink/pull/38), [#61](https://github.com/4thtech/agentlink/pull/61)): Content-key wrap (RFC 9180 HPKE) and payload encryption (AES-256-GCM) with key commitment are merged; the recompute vectors follow.
>   - EIP-712 typed data and the agent card ([#32](https://github.com/4thtech/agentlink/pull/32)): Typed-data hashing and the signed agent card.
>   - Owner passphrase wrap, pairing proof, safety code ([#37](https://github.com/4thtech/agentlink/pull/37)): The owner passphrase wrap, the pairing proof and the pairing safety code.
>   - Key interfaces, NIP-44 v2, gift wrap ([#41](https://github.com/4thtech/agentlink/pull/41), [#42](https://github.com/4thtech/agentlink/pull/42), [#55](https://github.com/4thtech/agentlink/pull/55)): `KeyStore`, `OwnerKeyStore`, an in-memory test store, NIP-44 v2 and gift wrap; owner-only epoch advance.
>   - Independent test vectors (in progress; [#25](https://github.com/4thtech/agentlink/pull/25), [#35](https://github.com/4thtech/agentlink/pull/35), [#72](https://github.com/4thtech/agentlink/pull/72), [#75](https://github.com/4thtech/agentlink/pull/75)): Vector suites from independent generators for the merged crypto suites; more follow with each suite.
>   - File encryption (ALF1) (planned): STREAM file encryption, with M1b.
> - **Shared types (@agentlink/types):** Code merged, none of it published.
>   - Constants and the envelope, payload, card and invite schemas ([#23](https://github.com/4thtech/agentlink/pull/23), [#93](https://github.com/4thtech/agentlink/pull/93)): Merged, with per-path canonical decoders, the `encodings` vector suite and the 12 288-byte inline cap.
>   - Policy, approval, proof pack and tool-result types ([#31](https://github.com/4thtech/agentlink/pull/31), [#36](https://github.com/4thtech/agentlink/pull/36), [#71](https://github.com/4thtech/agentlink/pull/71), [#72](https://github.com/4thtech/agentlink/pull/72), [#76](https://github.com/4thtech/agentlink/pull/76)): The policy document, approvals including batch approval, pairing bodies, relay lists, `contact.check` params; tested in Node, three browsers and workerd.
> - **Transport (@agentlink/transport-nostr):** Code merged, not published.
>   - Gift wrap and unwrap ([#45](https://github.com/4thtech/agentlink/pull/45)): Each envelope is sealed with the sender's key and wrapped once per recipient key; tested for interop with the `nostr-tools` reference.
>   - Relay pool and delivery outbox ([#59](https://github.com/4thtech/agentlink/pull/59)): Publishes a wrap to its relays, counts it sent at 2 acknowledgements and retries for 24 h.
>   - Sync ([#63](https://github.com/4thtech/agentlink/pull/63)): Reads each relay for new gift wraps, 48 h back from a per-relay cursor, hands each over once, and returns what it has after 3 s, flagged as partial.
>   - Outbox stays inside the sync look-back ([#87](https://github.com/4thtech/agentlink/pull/87)): The outbox stops republishing outside the sync look-back (M1-5f).
> - **Core (@agentlink/core):** Code merged, not published. Nothing in it is user-runnable yet.
>   - Skeleton: identity, contacts, store and approval interfaces ([#48](https://github.com/4thtech/agentlink/pull/48)): The agent's identity and signed card, contacts (pairing commit, block, remove), an in-memory test store.
>   - Envelopes ([#66](https://github.com/4thtech/agentlink/pull/66)): Building, signing and verifying envelopes in the specified order; the owner can always read; held envelopes across a contact's key rotation.
>   - Invites and pairing ([#78](https://github.com/4thtech/agentlink/pull/78)): Single-use invite links, the handshake and ack with the commit-then-reveal safety code.
>   - Safety code checked ([#80](https://github.com/4thtech/agentlink/pull/80), [#85](https://github.com/4thtech/agentlink/pull/85)): The owner's signed check, applied only when it matches the recomputed pairing and re-verified on every read; it goes through the owner-action path.
>   - Owner-signed actions and policies ([#79](https://github.com/4thtech/agentlink/pull/79)): Approvals, batch approvals, cancellations and policy changes apply only with a valid owner signature, once each; a stored policy that no longer verifies makes the agent ask the owner.
>   - Approval requests and the requests queue ([#95](https://github.com/4thtech/agentlink/pull/95)): Approval requests with use-once, requests-queue limits and idempotency (M1-7e). A follow-up for requests from unknown senders (accept, ignore, block) is in review.
>   - Held cards need the sender's own owner entry ([#90](https://github.com/4thtech/agentlink/pull/90)): A held card is accepted only with the sender's own owner entry (G-51).
>   - Send pipeline (in progress; [#99](https://github.com/4thtech/agentlink/pull/99)): Sending a message to a paired contact, stored with its delivery rows before anything is published, retried from the outbox, with one publisher per row when several processes share the agent (M1-7k); in review.
>   - Inbox sync, delivery acknowledgements, owner card update (in progress; [#106](https://github.com/4thtech/agentlink/pull/106)): Inbox sync with a per-contact rate limit, opt-in delivery acknowledgements and a fetch-only catch-up for read-only status (M1-7h); in progress. Owner-signed revocations of contacts and of the agent itself are applied; the owner card update (M1-7j, M1b) follows.
> - **Node runtime (@agentlink/node):** Code merged, not published. Nothing in it is user-runnable yet.
>   - Agent key store in the OS keychain ([#54](https://github.com/4thtech/agentlink/pull/54), [#57](https://github.com/4thtech/agentlink/pull/57), [#83](https://github.com/4thtech/agentlink/pull/83)): macOS Keychain, Windows Credential Manager, Linux Secret Service, with the "needs setup" answer on machines without one; CI runs on all three.
>   - Local SQLite database ([#60](https://github.com/4thtech/agentlink/pull/60), [#68](https://github.com/4thtech/agentlink/pull/68)): Sensitive columns encrypted under a key from the keychain, shared safely by several processes.
>   - Owner code at a prompt ([#67](https://github.com/4thtech/agentlink/pull/67)): The owner's key store unlocked with the owner code or passphrase; batch approval.
>   - Relay connection ([#81](https://github.com/4thtech/agentlink/pull/81), [#84](https://github.com/4thtech/agentlink/pull/84)): Connects only to an address that passed the relay address check, refuses redirects and proxies, caps incoming messages; a Docker relay suite runs in CI.
>   - Policy version record in the keychain ([#86](https://github.com/4thtech/agentlink/pull/86)): Stops an older owner-signed policy from being put back.
>   - Passphrase-locked key file for headless machines (planned): M1-8f.
> - **MCP server, CLI and apps:** Nothing built yet.
>   - MCP server and CLI (planned): `npx` package with the MCP server over stdio and the `agentlink` CLI (M1a).
>   - Local approval page (planned): A small page on 127.0.0.1 for owner approvals and settings (M1b).
>   - Owner console, desktop apps, cloud agent (planned): M2.
> - **OCC v2 contracts (private repo):** Pre-audit. Nothing in AgentLink uses them yet.
>   - Notary and fee vault (contracts#4): Developed in the private contracts repo; their test and static-analysis review continues.
>   - Testnet deployment ([#65](https://github.com/4thtech/agentlink/pull/65), contracts#8, contracts#9): Deployed on the Base Sepolia testnet; a live smoke test passed on 14 Oct 2026.
>   - Gnosis Chiado deployment, ABI package, pre-audit fixes (planned): Follow-ups for M1b; mainnet follows the external audit (M3).
> - **Design:** Tracked in `docs/design/`.
>   - Design drop D1 ([#33](https://github.com/4thtech/agentlink/pull/33)): Brand core, tokens, components and the local approvals screens.
>   - Design drop D2 (in progress; [#82](https://github.com/4thtech/agentlink/pull/82)): Console, desktop apps, onboarding and more; partly in.
> - **Testnet:** OCC v2 notary and fee vault deployed and smoke-tested on 14 Oct 2026. Pre-audit; AgentLink does not use them yet.
> - **Mainnet:** After the external audit (M3). Not deployed.
> - **In progress:** The send pipeline in core (M1-7k) and the terms schema (M1-21), and the decomposition of the MCP server and CLI into cards. Next: inbox sync, the MCP server and CLI, then file encryption and the remaining contract work.
> - **Does not exist yet:** a usable product. The packages are private and nothing is published; only the crypto, types, transport, core, node and logging foundations listed here contain code. **There is nothing to install or run yet.** The design is described throughout and marked "planned" where it is not built.
> - **Next:** The rest of the M1a crypto and core layers, then the walking skeleton where two agents on different harnesses pair and talk (v0.1.0); then M1b adds files, proof and credits on testnets.
>
> We build in public. This section is generated from [`docs/status.yaml`](docs/status.yaml) (`node tools/docs-status/index.mjs`) and checked in CI, so it is as current as that file, which every status-changing pull request updates.
<!-- status:end -->

## Why

AI agents from different people and companies cannot safely work together today:

- **No shared channel.** Agents on different harnesses have no common way to reach each other.
- **No end-to-end privacy.** Hand-offs go through email, chat apps or shared drives that can read them.
- **No proof.** Nothing shows what was sent, when, or whether the other side received it.
- **No owner supervision.** The human responsible has no clear view of, or control over, what their agents exchange.

## How it works

The design (planned, not yet built): the only setup is adding the AgentLink MCP server to your harness, and your own agent can do that for you. No wallet, browser extension or chain choice. Everything sensitive happens on your side. Your harness calls one MCP server, which runs on your computer (or in your own cloud account) and uses a shared core for keys, encryption, envelopes and policies. Anything outside your side may be malicious or compromised without exposing content or keys. At worst it can withhold or delay service.

```mermaid
flowchart LR
  subgraph UserSide["Your side - keys live here"]
    H["Harness: Claude, Codex, Gemini"] -->|"MCP tools"| M["AgentLink MCP server"]
    M --> C["Core: crypto, envelopes, policies"]
  end
  C -->|"encrypted messages"| R["Nostr relays"]
  C -->|"encrypted files (default)"| D["Encrypted drop: 4thTech, ciphertext only"]
  C -.->|"encrypted files (optional)"| S["Your own storage"]
  C -->|"signed records"| E["EVM chains: OCC v2 notary on Base and Gnosis"]
  C -.->|"optional"| F["4thTech conveniences: submitter, relay, static pages"]
  F -.->|"submits records"| E
```

- **Messages** travel as end-to-end encrypted, gift-wrapped Nostr events. The owners of both agents can read them.
- **Files** are encrypted on your device. Larger files go through a zero-knowledge **encrypted drop** run by 4thTech, so sending a file needs no setup (planned): the drop stores only ciphertext under random names and deletes it within 7 days. Your own storage is optional (S3-compatible; Google Drive, Dropbox and OneDrive in the desktop apps, planned). The recipient gets a time-limited link and the key inside the encrypted message. Drop and S3 links expire after 7 days at most; Google Drive, Dropbox and OneDrive cannot always enforce that, so your agent removes the file and its link at expiry (best effort; the file stays encrypted).
- **Proof** is an on-chain record of an envelope's hash with signed receipts from the recipient. Anyone can check a proof pack against the chain without an account.
- **4thTech conveniences** (a fee submitter, an optional relay, the encrypted drop, static web pages) are zero-knowledge. They see only ciphertext, signed hashes, sizes, timing and network addresses, never content, file keys or contact lists.

## Use cases (planned)

- **Shared projects.** Two developers' coding agents (say, Claude Code and Codex) keep a shared project in sync: status, decisions and hand-offs, end-to-end encrypted.
- **Proof of agreement.** Agents negotiate terms (deliverables, price, deadlines) over messages; the owner approves the binding accept, and the final terms plus the other side's acceptance are recorded as proof.
- **Document handover.** An agent sends a contract or report as an encrypted file and gets delivery and acceptance receipts anyone can verify.

## Free vs paid

| Action | Cost |
|---|---|
| Install, identity, pairing, contacts | Free |
| Encrypted messages and acknowledgements | Free |
| Send files (inline, through the encrypted drop, or via your own storage) | Free within the drop's quotas (your own storage may bill you) |
| Owner console, policies, approvals, local verify | Free |
| **Add proof** (record, with up to 3 receipts) | $0.10, paid by the sender |
| **Verified registration** of an agent | $5 one-time, paid by the owner |
| Batched receipts, deal records, arbitrator disclosure | Fee, planned for later |

**There is no token.** Fees exist only for on-chain proof, are paid in stablecoins (USDC/USDT, xDAI on Gnosis) and are shown in dollars before any paid action, at the same price on every network. These are planned beta prices, not live yet; paid proof starts with the mainnet beta (M3). On testnets, credits come from a free faucet (planned). Fee schedule, caps and price-change policy: [`12-economics-and-fees.md`](docs/foundation/12-economics-and-fees.md).

## Principles

1. **Zero access.** 4thTech holds no private keys, plaintext, contact lists or accounts.
2. **Free to start.** No sign-up, no payment, no balance needed for messages and files.
3. **Pay only for proof.** Fees apply only to on-chain actions.
4. **No crypto in the UX.** One passkey and a recovery kit; prices in dollars; chain details only under "Advanced".
5. **Files work out of the box.** A zero-knowledge encrypted drop (ciphertext only, deleted within 7 days) means no storage setup; your own storage is optional.
6. **Token-less.** No project token.
7. **Harness-agnostic.** Everything works through MCP, with no harness-specific lock-in.

## Planned surfaces

| Surface | What it is | Status |
|---|---|---|
| Local: `npx` package | MCP server over stdio plus an `agentlink` CLI (keys in the OS keychain); your agent can install it from a prompt | planned (M1) |
| Local: approval page | Small page on `127.0.0.1` for owner approvals and settings | planned (M1) |
| Local: desktop apps | Signed apps for macOS, Windows and Linux: a full local dashboard, tray, and approvals with Touch ID or Windows Hello | planned (M2) |
| Cloud: self-host | Always-on agent with a remote MCP endpoint in your **own** Cloudflare account | planned (M2) |
| Cloud: owner console | Zero-knowledge web app with passkey login for supervising agents | planned (M2) |
| Web: view and accept | A counterparty without an agent views and accepts an offer from the invite link | planned (M2) |
| Web: verify page | Public page to check a proof pack (the CLI command arrives in M1) | planned (M2) |

## Roadmap

Milestones are sequential gates ([build plan](docs/foundation/10-build-plan.md)).

<!-- roadmap:start -->
| Milestone | Gate |
|---|---|
| **M0 Foundations** (nearly complete) | Specs, repositories, CI and open decisions in place. Done so far: monorepo skeleton, Foundry skeleton in the private contracts repo, boundary guards, test-vector harness, redacting logger, delivery pipeline, runbooks, public docs structure and specs D-53 to D-59. Still open: a few CI follow-ups. |
| **M1a Walking skeleton: pair and talk** (in progress) | Two developers' agents (Claude Code and Codex) pair and keep a shared project in sync over AgentLink, and negotiate terms with owner approval. Crypto foundations, the transport (gift wrap, relays, sync), most of the core (envelopes, pairing, owner-signed actions and policies) and the node keychain, database and relay connection are merged; the approvals queue and the held-card owner entry are merged too; the send pipeline is in progress, and inbox sync, the MCP server and CLI come next. |
| **M1b Files, proof, credits** | 10 internal testers on at least 3 harness combinations complete setup, first message, a file handover with proof, an owner approval, a third-party verification and a proof of agreement (completes M1, testnets). |
| **M2 Owner console, desktop apps, self-host, design** | 20 to 50 external early adopters on testnets; install to first message in under 5 minutes. |
| **M3 Mainnet beta (Base, Gnosis)** | External audit findings (high and medium) fixed; first paid proofs with zero security incidents. |
| **M4 Expansion** | Rolling, no single gate yet: more proof networks, batched receipts, hosted approval-mode MCP, more adapters. |
| **M5 Agent commerce** | Rolling, no single gate yet: deal records, x402 settlement linkage, arbitrator disclosure. |
<!-- roadmap:end -->

**Versioning.** [SemVer](https://semver.org): M0 = 0.0.x, M1a = 0.1.0, M1 = 0.2.0, M2 = 0.3.0, and the M3 mainnet beta = 1.0.0. See [`versioning.md`](docs/process/versioning.md).

## Documentation

- [`docs/README.md`](docs/README.md): the documentation map, with reading paths.
- [`docs/explainers/`](docs/explainers/): plain-language guides.
- [`knowledge/`](knowledge/README.md) and [`llms.txt`](llms.txt): the compressed public knowledge base for AI assistants and quick reading, updated with every milestone or release.
- [`docs-site/`](docs-site/README.md): the public documentation, a user guide and technical docs, for publishing on GitBook. Pages for features not built yet are marked planned.
- [`CHANGELOG.md`](CHANGELOG.md): what changed in each release.
- [`docs/process/versioning.md`](docs/process/versioning.md): how versions and releases work.
- [`CONTRIBUTING.md`](CONTRIBUTING.md): how to take part.
- [`SECURITY.md`](SECURITY.md): how to report a vulnerability.
- [`AGENTS.md`](AGENTS.md): the rules for AI agents working in this repository.

## Repository map

| Path | Contents |
|---|---|
| [`docs/foundation`](docs/foundation/00-README.md) | Specs and decision log, including the [security and crypto](docs/foundation/04-security-and-crypto.md) invariants and the [build plan](docs/foundation/10-build-plan.md) |
| [`docs/process`](docs/process/development-process.md) | How we build: orchestrated AI agents with human review, [audit rules](docs/process/audit-rules.md), and continuous delivery with an owner-approved production step ([release and deployment](docs/process/release-and-deployment.md), [CI/CD](docs/process/ci-cd.md)) |
| `.github` | Workflows, issue and PR templates |
| `packages/`, `apps/`, `skills/`, `test-vectors/`, `e2e/` | **Coming in M1** (see the [repository reference](docs/process/repo-reference.md)); the console, verify, invite, cloud-agent and `ui` pieces follow in M2 |

The OCC v2 smart contracts are developed in a separate private repository during beta. Verified source will be published at mainnet.

## Security

Report vulnerabilities privately through GitHub: see [SECURITY.md](SECURITY.md). Do not open public issues for them.

The design rests on invariants in [`04-security-and-crypto.md`](docs/foundation/04-security-and-crypto.md): private keys and plaintext never reach any 4thTech service, relay or log; 4thTech services must stay safe even if fully compromised; owner actions need the owner's presence and signature, which no MCP tool can produce; inbound agent content is always treated as untrusted data. An external audit of the contracts, and an independent review of the crypto and core packages, are planned before mainnet.

## Contributing and working with agents

Much of this project is built by orchestrated AI agents under human review, so the rules for agents and people are the same. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for how work is organised, and [`AGENTS.md`](AGENTS.md) if you are (or run) an agent. Code contributions open after the M1a skeleton lands; for now, [issues](https://github.com/4thtech/agentlink/issues) are open for feedback. Please follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Hosting and public docs

The testing environment will live at `agentlink.4thtech.io` (planned). The public docs (a user guide and technical docs) are written in [`docs-site/`](docs-site/README.md) and will be published on GitBook through Git Sync (planned). They describe the design and mark every feature that is not built yet as planned. [wiki.4thtech.io](https://wiki.4thtech.io) documents OCC v1.

## License

[MIT](LICENSE). The OCC v2 contracts are planned to be published under BUSL-1.1 at mainnet (pending legal confirmation, decision D-11).
