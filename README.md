# AgentLink by 4thTech: encrypted, provable exchange between AI agents

[![CI](https://github.com/4thtech/agentlink/actions/workflows/ci.yml/badge.svg)](https://github.com/4thtech/agentlink/actions/workflows/ci.yml) [![Security checks](https://github.com/4thtech/agentlink/actions/workflows/security.yml/badge.svg)](https://github.com/4thtech/agentlink/actions/workflows/security.yml) [![Status: pre-alpha](https://img.shields.io/badge/status-pre--alpha-orange)](#status) [![Milestone: M0 Foundations](https://img.shields.io/badge/milestone-M0%20Foundations-blue)](#roadmap) [![Latest release](https://img.shields.io/github/v/release/4thtech/agentlink?include_prereleases&sort=semver)](https://github.com/4thtech/agentlink/releases) [![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE) [![Token-less: no project token](https://img.shields.io/badge/token--less-no%20project%20token-lightgrey)](#principles) [![Built in public](https://img.shields.io/badge/built%20in-public-brightgreen)](https://github.com/4thtech/agentlink)

AgentLink lets AI agents on different harnesses (Claude, Codex, Gemini and any MCP-capable client) exchange end-to-end encrypted messages and files, and add verifiable proof when it matters. It is client software plus a protocol. 4thTech never sees keys, message or file contents, or contacts.

*AgentLink is a working name. The protocol underneath is **OCC v2** (4thTech On-Chain Communication, version 2).*

## Status

> **Phase:** M0 Foundations (pre-alpha) · **Version:** v0.0.1 (M0 Foundations) · **Last updated:** 2026-10-12
>
> - **Exists today:** specifications ([`docs/foundation`](docs/foundation/00-README.md)), the development and audit process ([`docs/process`](docs/process/development-process.md)), CI workflows and repository checks, and a [security policy](SECURITY.md).
> - **Does not exist yet:** product code. **There is nothing to install or run yet.** Everything below describes the design and is marked "planned" where it is not built.
> - **Next:** M1a, a walking skeleton where two agents on different harnesses pair and talk (v0.1.0); then M1b adds files, proof and credits on testnets.
>
> We build in public. This section is kept current: it is updated whenever a milestone, release or user-visible capability changes.

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

| Milestone | Gate |
|---|---|
| **M0 Foundations** (in progress) | Specs, repositories, CI and open decisions in place. |
| **M1a Walking skeleton: pair and talk** | Two developers' agents (Claude Code and Codex) pair and keep a shared project in sync over AgentLink, and negotiate terms with owner approval. |
| **M1b Files, proof, credits** (completes M1, testnets) | 10 internal testers on at least 3 harness combinations complete setup, first message, a file handover with proof, an owner approval, a third-party verification and a proof of agreement. |
| **M2 Owner console, desktop apps, self-host, design** | 20 to 50 external early adopters on testnets; install to first message in under 5 minutes. |
| **M3 Mainnet beta** (Base, Gnosis) | External audit findings (high and medium) fixed; first paid proofs with zero security incidents. |
| **M4 Expansion** | Rolling, no single gate yet: more proof networks, batched receipts, hosted approval-mode MCP, more adapters. |
| **M5 Agent commerce** | Rolling, no single gate yet: deal records, x402 settlement linkage, arbitrator disclosure. |

**Versioning.** [SemVer](https://semver.org): M0 = 0.0.x, M1a = 0.1.0, M1 = 0.2.0, M2 = 0.3.0, and the M3 mainnet beta = 1.0.0. See [`versioning.md`](docs/process/versioning.md).

## Documentation

- [`docs/README.md`](docs/README.md): the documentation map, with reading paths.
- [`docs/explainers/`](docs/explainers/): plain-language guides.
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

The testing environment will live at `agentlink.4thtech.io` (planned). Public docs will be on [wiki.4thtech.io](https://wiki.4thtech.io), which currently documents OCC v1 only; AgentLink and OCC v2 pages will be added when there is something to deploy.

## License

[MIT](LICENSE). The OCC v2 contracts are planned to be published under BUSL-1.1 at mainnet (pending legal confirmation, decision D-11).
