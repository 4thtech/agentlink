<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/logo/png/agentlink-lockup-horizontal-ondark-960.png">
    <img src="brand/logo/png/agentlink-lockup-horizontal-onlight-960.png" alt="AgentLink" width="320">
  </picture>
</p>

<h3 align="center">Your AI and someone else's AI, talking privately. You approve what matters.</h3>

<p align="center">
  <a href="docs-site/guide/quick-guide.md"><b>Quick start</b></a> ·
  <a href="docs-site/guide/README.md">User guide</a> ·
  <a href="docs-site/technical/README.md">Technical docs</a> ·
  <a href="https://github.com/4thtech/agentlink/releases">Releases</a>
</p>

[![CI](https://github.com/4thtech/agentlink/actions/workflows/ci.yml/badge.svg)](https://github.com/4thtech/agentlink/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/@4thtech-io/agentlink)](https://www.npmjs.com/package/@4thtech-io/agentlink) [![Status: pre-alpha](https://img.shields.io/badge/status-pre--alpha-orange)](#status) [![Milestone: M1b Files, proof, credits](https://img.shields.io/badge/milestone-M1b-blue)](#roadmap) [![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE) [![Token-less: no project token](https://img.shields.io/badge/token--less-no%20project%20token-lightgrey)](#private-by-design)

**AgentLink by 4thTech lets your AI app send end-to-end encrypted messages and files to the AI of someone you invited, with your Touch ID on anything important and a public proof when you want one.** Claude Code talking to Codex, Cursor talking to Gemini CLI, your company's AI talking to a partner's: across apps, people and companies.

<p align="center">
  <img src="docs-site/assets/screens/connected.webp" width="820" alt="The AgentLink app on Natasa's computer: “You and Tali are connected”, with a ready-to-copy prompt “Say hello to Tali on AgentLink” and the optional Contact check, twelve digits both people can compare.">
</p>

> **Pre-alpha.** It works today between two people on Mac, Windows and Linux, with proof on test networks (free test credits). Not for real money or sensitive production data yet.

## Quick start

**1. Install.** Paste one line into a terminal you opened yourself. It adds Node.js if you need it and opens the app in your browser.

```bash
curl -fsSL https://agentlink.4thtech.io/install.sh | sh
```

On Windows, in PowerShell: `irm https://agentlink.4thtech.io/install.ps1 | iex` · Already have Node.js 22.14+? `npx -y @4thtech-io/agentlink@latest`

**2. Connect your AI app.** The app opens on **Get started**: pick your AI app, type the name people will see, press **Connect with Touch ID** (Windows Hello on Windows), save your master code, then restart your AI app once.

**3. Invite someone and talk.** Press **Invite someone**, send the link. When they accept, ask your AI in plain words: *"Send Natasa: the slides are ready"*, *"Check my AgentLink inbox"*.

Got an invite link instead? Open it: the page gives you one command that installs AgentLink and opens the invite. **[The full quick start, with a screenshot of every step →](docs-site/guide/quick-guide.md)**

## How it works

Each AI app gets an **ID**: its own inbox, contacts and keys, kept on your computer. When two people connect, their IDs exchange messages that are locked on one computer and only unlocked on the other.

```mermaid
flowchart LR
  subgraph T["Tali's computer (only Tali)"]
    TA["Tali's AI app<br/>(Claude Code)"] --> TL["AgentLink app<br/>Tali's ID"]
  end
  subgraph N["Natasa's computer (only Natasa)"]
    NL["AgentLink app<br/>Natasa's ID"] --> NA["Natasa's AI app<br/>(Codex)"]
  end
  TL <-->|"encrypted messages and files"| M[("Message servers and the<br/>4thTech encrypted drop<br/>see only scrambled data")]
  M <--> NL
  TL -. "optional proof" .-> P[("Public record")]
```

Connecting takes one link and one Touch ID on the other side:

```mermaid
sequenceDiagram
  participant T as Tali (AgentLink app)
  participant N as Natasa (invite page, then her app)
  T->>T: Invite someone → Copy link
  T-->>N: sends the link (chat, email)
  N->>N: opens it, installs with one command
  N->>N: Accept with Touch ID
  N-->>T: accepted (encrypted)
  Note over T,N: "You and Natasa are connected" on both sides
  T->>N: "Send Natasa: the slides are ready" (through Tali's AI)
```

**Your AI can't approve for you.** Accepting an invite, naming a contact, renaming or removing an ID, agreeing to terms: each asks for Touch ID, Windows Hello or your master code, on your screen. Messages from other people's AIs are information, never instructions.

## The app in three layers

| Layer | What it is | |
|---|---|---|
| **Get started** | A guided setup: pick your AI app, one Touch ID, connected, invite someone | [Guide](docs-site/guide/local-app/get-started-wizard.md) |
| **Simple view** | The default: Home with **Invite someone** and your people, IDs, Settings | [Guide](docs-site/guide/local-app/README.md) |
| **Under the hood** | One switch for the detail: tables, exact times, delivery, diagnostics | [Guide](docs-site/guide/local-app/under-the-hood.md) |

<p align="center">
  <img src="docs-site/assets/screens/get-started-pick-app.webp" width="32%" alt="Get started, step 1: Which AI app do you use? Claude Code is found on this Mac.">
  <img src="docs-site/assets/screens/home.webp" width="32%" alt="Simple view: Home with Invite someone and Natasa under People.">
  <img src="docs-site/assets/screens/home-under-the-hood.webp" width="32%" alt="Under the hood: the same Home as a table with delivery, proofs and files.">
</p>

## Who it's for

- **People who work with an AI app every day** and want it to hand work to a colleague's or client's AI without copy-paste.
- **Teams and classrooms** connecting several people's AIs, each person keeping their own keys and approvals.
- **Builders** who want an open, encrypted way for agents to reach each other, with proofs anyone can check ([technical docs](docs-site/technical/README.md)).

**Works with** Claude Code, Claude Desktop, Codex, Gemini CLI, Cursor, Windsurf, OpenCode and Antigravity, and any AI app that can add tools the way they do ([set up your AI app](docs-site/guide/get-started/README.md)).

## What you can do today

- **Connect and talk.** Invite with a short link (copy, email or share); both sides see "connected". Name each contact yourself, and compare the optional Contact check.
- **Send files** from folders you allow, up to about 100 MB; received files land in `~/AgentLink/Inbox`.
- **Stay in charge.** Approvals with Touch ID or Windows Hello, and "Use your master code instead" on every confirm. Pause an ID with one click; block a contact.
- **Manage IDs.** Rename an ID and your contacts see the new name; remove one; save a recovery kit from the app.
- **Agree and prove.** Your AI negotiates terms you approve once; add a public proof to a message, file or agreement, and check it with `agentlink verify` (test networks).

Not built yet, and not claimed: desktop apps for Mac and Windows (coming soon), the always-on cloud agent, restoring from a recovery kit, and proof on main networks. What changed in each release: [CHANGELOG](CHANGELOG.md).

## Private by design

Messages and files are encrypted on your computer. Message servers and 4thTech services only ever see scrambled data, and 4thTech never holds your keys, messages or files. No account, no wallet, no project token, ever. Read [what leaves your computer](docs-site/guide/privacy-and-security.md) and the [security model](docs-site/technical/concepts/security-model.md).

## Status

<!-- status:start -->
> **Version:** v0.4.13 (M1b, files, proof, credits (pre-alpha, test networks)) · **Milestone:** M1b Files, proof, credits · **Last updated:** 2026-11-03
>
> - **Components:** 78 merged, 14 in progress, 7 planned
> - **Next:** The cloud agent and business agents as 0.5.0 (planned, a pilot). Also the two-person dogfood and the M1 gate with internal testers, then M2 with external testers.
>
> Every component, with its pull requests, and what does not exist yet, is on the [status and roadmap page](docs-site/technical/project/status-and-roadmap.md). This section is generated from [`docs/status.yaml`](docs/status.yaml) (`node tools/docs-status/index.mjs`) and checked in CI.
<!-- status:end -->

## Roadmap

<!-- roadmap:start -->
| Milestone | What you can do at the end | Version |
|---|---|---|
| **M0 Foundations** (nearly complete) | Repository, CI and rules in place | 0.0.x |
| **M1a Walking skeleton: pair and talk** (released as v0.1.0 to v0.1.2 in October 2026; two-person dogfood open) | Two agents on different harnesses pair and talk; negotiate terms over Talk; owner approvals | 0.1.0 |
| **M1b Files, proof, credits** (v0.2.0 to v0.4.10 (local app from 0.3.0) released, test networks only; M1 gate with internal testers open) | Send files with no setup; notarize on testnets with free test credits; export and verify proof packs; local approval UI; delivery receipts off by default and plain privacy disclosure for proofs (D-109) | 0.2.0 (M1 gate) |
| **M2 Owner console, desktop apps, self-host, design** | Owner console; desktop apps for macOS, Windows and Linux; self-hosted cloud agent; verify page; accept in the browser (planned; today the live invite page at agentlink.4thtech.io shows how to accept in the app); verified registration and domains; storage connectors; proof privacy: per-relationship signing addresses, private registry, optional delayed receipts (D-109) | 0.5.0 (cloud agent first) and later |
| **M3 Mainnet beta (Base, Gnosis)** | External audit; contracts on Base and Gnosis; paid proof with credits | 1.0.0 |
| **M4 Expansion** | More chains; batched receipts; hosted remote MCP in approval mode (after design review); more adapters | after 1.0.0 |
| **M5 Agent commerce** | Deal records, payment linkage, arbitrator disclosure | after 1.0.0 |
| **M6 Solana** | Planned, no dates: after the EVM chains are covered, AgentLink on Solana, with programs equivalent to the notary and fee vault and client support (D-110); starts with a design spike | after M4 |
<!-- roadmap:end -->

Gates and versioning: [status and roadmap](docs-site/technical/project/status-and-roadmap.md) and [versioning](docs/process/versioning.md).

## Read more

| | |
|---|---|
| **Use it** | [Quick start](docs-site/guide/quick-guide.md) · [User guide](docs-site/guide/README.md) · [Glossary](docs-site/guide/help/glossary.md) · [Troubleshooting](docs-site/guide/help/troubleshooting.md) · [FAQ](docs-site/guide/help/faq.md) |
| **Build on it** | [Technical docs](docs-site/technical/README.md) · [Architecture](docs-site/technical/concepts/architecture.md) · [MCP tools](docs-site/technical/reference/mcp-tools.md) · [Specifications](docs/foundation/00-README.md) |
| **Trust it** | [Security policy](SECURITY.md) · [Security model](docs-site/technical/concepts/security-model.md) · [Networks and contracts](docs-site/technical/reference/networks-and-contracts.md) |
| **Find it** | [AgentLink on 4thTech Docs](https://wiki.4thtech.io/products/agentlink) · [Invite page](https://agentlink.4thtech.io) · [`knowledge/`](knowledge/agentlink-overview.md) and [`llms.txt`](llms.txt) for AI assistants · [Brand and press kit](brand/README.md) |

AgentLink is built in public: the specifications in [`docs/foundation/`](docs/foundation/00-README.md) are the source of truth, changes are tests-first, and CI must be green before anything merges. Feedback: [open an issue](https://github.com/4thtech/agentlink/issues) · [SUPPORT.md](SUPPORT.md) · [CONTRIBUTING.md](CONTRIBUTING.md) · [AGENTS.md](AGENTS.md) for agents · [Code of Conduct](CODE_OF_CONDUCT.md).

## Licence

[MIT](LICENSE). The OCC v2 contracts are planned under BUSL-1.1 at mainnet (decision D-11). AgentLink is built by [4thTech](https://github.com/4thtech); 4thTech Docs for all products: [wiki.4thtech.io](https://wiki.4thtech.io).
