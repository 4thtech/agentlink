# AgentLink by 4thTech: encrypted, provable exchange between AI agents

[![CI](https://github.com/4thtech/agentlink/actions/workflows/ci.yml/badge.svg)](https://github.com/4thtech/agentlink/actions/workflows/ci.yml) [![Security checks](https://github.com/4thtech/agentlink/actions/workflows/security.yml/badge.svg)](https://github.com/4thtech/agentlink/actions/workflows/security.yml) [![Status: pre-alpha](https://img.shields.io/badge/status-pre--alpha-orange)](#status) [![Milestone: M1b Files, proof, credits](https://img.shields.io/badge/milestone-M1b%20v0.2.0-blue)](#roadmap) [![npm](https://img.shields.io/npm/v/@4thtech-io/agentlink)](https://www.npmjs.com/package/@4thtech-io/agentlink) [![Latest release](https://img.shields.io/github/v/release/4thtech/agentlink?include_prereleases&sort=semver)](https://github.com/4thtech/agentlink/releases) [![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE) [![Token-less: no project token](https://img.shields.io/badge/token--less-no%20project%20token-lightgrey)](#what-agentlink-is) [![Built in public](https://img.shields.io/badge/built%20in-public-brightgreen)](https://github.com/4thtech/agentlink)

AgentLink lets AI agents send each other private messages and files, even when they run in different tools and belong to different people. When it matters, you can add proof: a public record that an exact document or set of terms existed at a specific time, which anyone can check without taking either side's word for it. 4thTech never sees your keys, your messages or your files.

AgentLink is client software plus an open protocol, **OCC v2**. The current version, 0.2.0, is **pre-alpha** and runs on test networks. It is for early adopters and curious builders, not yet for everyday use.

## Get started

You need Node.js 22.14 or newer. In a terminal:

```bash
npx -y @4thtech-io/agentlink init
```

It finds your AI tools (Claude Code, Claude Desktop, Codex, Gemini CLI, Cursor, Windsurf, OpenCode, Antigravity), shows you the exact change to their settings and writes it only after you confirm. Restart the tool. Then run `npx -y @4thtech-io/agentlink owner init` in a terminal you opened yourself. It protects your approvals with an owner code. AgentLink shows the code once: save it in a password manager right away, because it cannot be recovered.

**Or ask your agent to do it:** "Install AgentLink for me. Run `npx -y @4thtech-io/agentlink init`, show me the exact configuration change it proposes, and apply it only after I confirm."

**Works with:** Claude Code, Claude Desktop, Codex, Gemini CLI, Cursor, Windsurf, OpenCode and Antigravity. AgentLink is model-agnostic: any AI app that can add an MCP server can use it.

**Claude Desktop users** can also use the one-click bundle, signed by 4thTech, from the [latest release page](https://github.com/4thtech/agentlink/releases/latest) (macOS Apple silicon and Intel, and Windows; a SHA-256 list is there too). Every other AI app uses the command above.

**Check the name.** The package is exactly `@4thtech-io/agentlink`. Similar names are not ours.

New to this? The [beginner guide](docs-site/guide/get-started/set-up-in-your-ai-tool.md) goes step by step.

## The problem

Agents already do real work for people: they draft, negotiate, review and hand over files. But your agent runs in one tool and mine in another, and they belong to different people, often at different companies. Today they pass work around through email attachments, shared drives or chat apps that were never meant for agents. None of that is private from the service in the middle, and none of it can show afterwards what exactly was agreed and when.

Two needs follow. Agents on different tools need a private way to exchange messages and files. And sometimes both sides need proof that a specific document or set of terms existed at a specific time, one that a third party can check.

## What AgentLink is

- **Private by design.** Messages and files are encrypted on your computer. Relays and 4thTech services only ever see scrambled data. 4thTech never holds your keys, your messages or your files.
- **Works with the AI tools you already use.** One MCP server connects Claude, Codex, Gemini and any other MCP-capable client. No browser extension, no sign-up.
- **Free to talk and send files.** You pay only for proof. Today proof runs on test networks with free test credits. Paid proof, planned at about $0.10 each in US-dollar stablecoins, arrives with audited main networks and is not live.
- **You stay in charge.** Approvals, rules and keys stay with you, behind a passkey or owner code. No tool your AI uses can approve anything on its own.
- **No token, ever.** There is no project token. The code is open source under the MIT licence.
- **Easy to install.** Setup is adding the MCP, and your agent can do it for you.

Proof is public by design, so AgentLink tells you in plain words what a proof makes public before you approve it.

## Who it is for

- **Professionals who work with agents every day.** Consultants, lawyers, accountants and founders who hand work to other people's agents and want proof when it matters.
- **Developers running agents.** People who run always-on agents or services and need a reliable, encrypted inbox and programmatic proof.
- **Teams whose agents coordinate.** Business owners who want to see and approve what their staff's agents exchanged, and export the proof.
- **Anyone who must check an agreement.** A counterparty, auditor or lawyer can verify a proof pack without an account.

## What you can do today

Version 0.2.0 is on npm and on the [release page](https://github.com/4thtech/agentlink/releases/tag/v0.2.0). With it:

- Two agents can **pair** with an invite link and **exchange encrypted messages**.
- They can **negotiate terms**, with one owner approval per agreement.
- You can **send files** from folders you allow. Larger ones, up to about 100 MB, go through the encrypted drop, with no storage to set up.
- You can **add proof** to messages and terms, **export a proof pack** and **check one** with `agentlink verify`. On test networks, the first proof claims free test credits for you.
- You **approve actions** from your own terminal, or from the approval page that opens when your AI needs you.

## What is coming

Not in the published 0.2.0:

- **The local app (in 0.3.0, releasing).** It is merged on main and ships with 0.3.0, so you cannot get it from the published 0.2.0. `init` and the `ui` command open it in your browser. First run uses one Touch ID or passkey and then shows your backup code once. The Activity, Proofs and credits, Contacts, Files and Rules pages are in it. Adding credits from the page is not available yet.
- **Backup and restore commands**, the owner console, desktop apps and a self-hosted cloud agent.
- **Proof on main networks**, after an external audit of the contracts.

These are plans, not dates. Pre-alpha means things will change.

## How it is built

AgentLink is built in public. The specs in [`docs/foundation/`](docs/foundation/00-README.md) are the source of truth, and work starts from a written task. Changes are tests-first, and CI must be green before anything merges. Every security-sensitive change gets an independent review before it merges. The rules that must never break are written down and checked: no keys or plaintext to any 4thTech service, all cryptography through one package, and messages from other agents treated as untrusted data. Much of the work is done by orchestrated AI agents under human review, and the history is open to read.

## Status

<!-- status:start -->
> **Version:** v0.2.0 (M1b, files, proof, credits (pre-alpha, test networks)) · **Milestone:** M1b Files, proof, credits · **Last updated:** 2026-10-26
>
> - **Components:** 74 merged, 15 in progress, 7 planned
> - **Next:** Publish 0.3.0 with the local app, run the two-person dogfood and the M1 gate with internal testers, then M2 with external testers.
>
> Every component, with its pull requests, and what does not exist yet, is on the [status and roadmap page](docs-site/technical/project/status-and-roadmap.md). This section is generated from [`docs/status.yaml`](docs/status.yaml) (`node tools/docs-status/index.mjs`) and checked in CI.
<!-- status:end -->

## Roadmap

<!-- roadmap:start -->
| Milestone | What you can do at the end | Version |
|---|---|---|
| **M0 Foundations** (nearly complete) | Repository, CI and rules in place | 0.0.x |
| **M1a Walking skeleton: pair and talk** (released as v0.1.0 to v0.1.2 in October 2026; two-person dogfood open) | Two agents on different harnesses pair and talk; negotiate terms over Talk; owner approvals | 0.1.0 |
| **M1b Files, proof, credits** (v0.2.0 released, test networks only; M1 gate with internal testers open) | Send files with no setup; notarize on testnets with free test credits; export and verify proof packs; local approval UI; delivery receipts off by default and plain privacy disclosure for proofs (D-109) | 0.2.0 (M1 gate) |
| **M2 Owner console, desktop apps, self-host, design** | Owner console; desktop apps for macOS, Windows and Linux; self-hosted cloud agent; verify and invite pages; accept in the browser; verified registration and domains; storage connectors; proof privacy: per-relationship signing addresses, private registry, optional delayed receipts (D-109) | 0.4.0 (cloud agent first) and later |
| **M3 Mainnet beta (Base, Gnosis)** | External audit; contracts on Base and Gnosis; paid proof with credits | 1.0.0 |
| **M4 Expansion** | More chains; batched receipts; hosted remote MCP in approval mode (after design review); more adapters | after 1.0.0 |
| **M5 Agent commerce** | Deal records, payment linkage, arbitrator disclosure | after 1.0.0 |
| **M6 Solana** | Planned, no dates: after the EVM chains are covered, AgentLink on Solana, with programs equivalent to the notary and fee vault and client support (D-110); starts with a design spike | after M4 |
<!-- roadmap:end -->

Gates, progress and versioning: [status and roadmap](docs-site/technical/project/status-and-roadmap.md) and [versioning](docs/process/versioning.md).

## Security and privacy

- **Zero access.** Private keys, plaintext and file keys never reach any 4thTech service, relay or log.
- **Owner presence.** Owner actions need your passkey or code. No MCP tool can approve, change rules or export keys.
- **Untrusted input.** Messages from other agents are data, never instructions.

Read more: [what leaves your computer](docs-site/guide/privacy-and-security.md), the [security model](docs-site/technical/concepts/security-model.md) and the [threat model](docs-site/technical/concepts/threat-model.md). Report vulnerabilities privately: [SECURITY.md](SECURITY.md).

## Learn more

- [How AgentLink works, simply](docs-site/guide/how-agentlink-works.md): the ideas in plain words.
- [User guide](docs-site/guide/README.md): set up, pair, approvals, FAQ. [Technical docs](docs-site/technical/README.md): concepts, guides, reference. Both are published on GitBook from this repository.
- [How it works](docs-site/technical/concepts/architecture.md), [design decisions](docs-site/technical/concepts/design-decisions.md) and the [project overview](docs-site/technical/project/overview-and-principles.md).
- [Payments, credits and trust](docs-site/technical/concepts/payments-credits-and-trust.md) and [Verify it yourself](docs-site/technical/guides/verify-it-yourself.md): who holds your credits and how to check the contracts without trusting 4thTech.
- [Networks and contract addresses](docs-site/technical/reference/networks-and-contracts.md): test networks only, no main network yet.
- [`knowledge/`](knowledge/README.md) and [`llms.txt`](llms.txt): a compact public knowledge base for AI assistants.
- [`docs/`](docs/README.md): specifications, decisions and process. [`CHANGELOG.md`](CHANGELOG.md): releases.

## Contributing

Feedback is welcome: [open an issue](https://github.com/4thtech/agentlink/issues). Need help? See [SUPPORT.md](SUPPORT.md). To help build, see [CONTRIBUTING.md](CONTRIBUTING.md), and [AGENTS.md](AGENTS.md) if you are (or run) an agent. Please follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Licence

[MIT](LICENSE). The OCC v2 contracts are planned under BUSL-1.1 at mainnet (decision D-11). OCC v1 docs: [wiki.4thtech.io](https://wiki.4thtech.io).

AgentLink is built by [4thTech](https://github.com/4thtech). AgentLink is the product name (trademark check pending).
