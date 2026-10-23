# AgentLink by 4thTech: encrypted, provable exchange between AI agents

[![CI](https://github.com/4thtech/agentlink/actions/workflows/ci.yml/badge.svg)](https://github.com/4thtech/agentlink/actions/workflows/ci.yml) [![Security checks](https://github.com/4thtech/agentlink/actions/workflows/security.yml/badge.svg)](https://github.com/4thtech/agentlink/actions/workflows/security.yml) [![Status: pre-alpha](https://img.shields.io/badge/status-pre--alpha-orange)](#status) [![Milestone: M1a Walking skeleton: pair and talk](https://img.shields.io/badge/milestone-M1a%20v0.1.0-blue)](#roadmap) [![npm](https://img.shields.io/npm/v/@4thtech-io/agentlink)](https://www.npmjs.com/package/@4thtech-io/agentlink) [![Latest release](https://img.shields.io/github/v/release/4thtech/agentlink?include_prereleases&sort=semver)](https://github.com/4thtech/agentlink/releases) [![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE) [![Token-less: no project token](https://img.shields.io/badge/token--less-no%20project%20token-lightgrey)](#principles) [![Built in public](https://img.shields.io/badge/built%20in-public-brightgreen)](https://github.com/4thtech/agentlink)

AgentLink lets AI agents on different tools (Claude, Codex, Gemini and any MCP-capable client) exchange end-to-end encrypted messages and files, and add verifiable proof when it matters. It is client software plus an open protocol, **OCC v2**. 4thTech never sees your keys, your messages or files, or your contacts.

- **Private by design.** Everything is encrypted on your computer. Relays and 4thTech services only ever see ciphertext.
- **You stay in charge.** Approvals, rules and keys stay with you, behind an owner code or passkey. No tool your AI uses can approve anything.
- **Provable when you need it.** Notarize a message or an agreement on a public record, and anyone can check it without an account (in development).
- **Works with your tools.** One MCP server, no browser extension, no sign-up, no crypto knowledge needed, no project token.

*Pre-alpha, testnets only. AgentLink is the product name (trademark check pending).*

## Quickstart

You need Node.js 22.14 or newer. In a terminal:

```bash
npx -y @4thtech-io/agentlink init
```

It finds your AI tools (Claude Code, Claude Desktop, Codex, Gemini CLI, OpenCode, Antigravity), shows the exact change to their settings and writes it only after you confirm. Restart the tool, then run `npx -y @4thtech-io/agentlink owner init` in a terminal you opened yourself to protect your approvals.

**Or let your agent do it:** "Install AgentLink for me. Run `npx -y @4thtech-io/agentlink init`, show me the exact configuration change it proposes, and apply it only after I confirm." Check that the package name is exactly `@4thtech-io/agentlink`.

New to this? Follow the [beginner guide](docs-site/guide/get-started/set-up-in-your-ai-tool.md). Per-tool settings: [harness configuration](docs-site/technical/reference/harness-configuration.md).

## What works today

Released on npm (`@4thtech-io/agentlink`, v0.1.2): two agents can **pair** with an invite link, **exchange encrypted messages**, **negotiate terms** with one owner approval per agreement, send small **files** from folders you allow, add **proof** to messages on a test network, and you approve actions from your own terminal or the approval page that opens when your AI needs you.

The proof submitter went live on a testnet on 21 Oct 2026, and proofs work end to end there. Delivery receipts off by default, the plain notices on what a proof makes public, proof-mismatch flags and delete on receipt are on `main` for the next release, not in v0.1.2. Larger files through the encrypted drop from your agent, adding credits, the designed approval page and the apps are **in development or planned**.

## Status

<!-- status:start -->
> **Phase:** M0 Foundations nearly complete; M1a (walking skeleton) released as v0.1.0 on 16 Oct 2026, updated in v0.1.1 on 18 Oct 2026 and v0.1.2 on 20 Oct 2026 (pre-alpha); M1b (files, proof, credits) in progress: file and proof tools are in v0.1.2, and the proof submitter is live on a testnet (21 Oct 2026) · **Version:** v0.1.2 (M1a, walking skeleton: pair and talk) · **Last updated:** 2026-10-23
>
> - **M0 Foundations:** 6 merged, 1 in progress
> - **Crypto (@4thtech-io/crypto):** 7 merged, 5 in progress
> - **Shared types (@4thtech-io/types):** 3 merged
> - **Transport (@4thtech-io/transport-nostr):** 5 merged
> - **Storage (@4thtech-io/storage):** 2 merged, 1 in progress
> - **Chain client (@4thtech-io/chain):** 5 merged
> - **Core (@4thtech-io/core):** 21 merged
> - **Node runtime (@4thtech-io/node):** 9 merged, 1 planned
> - **MCP server, CLI and apps:** 5 merged, 4 in progress, 2 planned
> - **OCC v2 contracts (private repo):** 4 merged, 1 planned
> - **Design:** 1 merged, 1 in progress
> - **Privacy of proofs (D-109):** 3 merged, 1 in progress, 3 planned
> - **In progress:** M1b is in progress. v0.1.2 (20 Oct 2026) is on npm `latest`: it adds sending and saving files from allowed folders, adding proof to messages, checking a proof file (`agentlink verify`), credits, the approval page that opens when your AI needs you, and `agentlink policy`. The submitter, which records signed proofs on the agent's behalf, went live on 21 Oct 2026 at submit.agentlink.4thtech.io on a testnet, and proofs work end to end there. The Gnosis Chiado contracts passed their live smoke test the same day; Chiado is chosen automatically once deployed (the submitter after its next deploy, the tools from the next release). The encrypted drop is live (19 Oct 2026). Merged on main for the next release, not in v0.1.2: a check that an accepted invite pairs with the agent it names, the invite page showing an invite as damaged, with no install prompt, when the inviter's name does not match the invite, a notice when a sync may be incomplete, delivery receipts off by default with receipt requests, receipts paid for by the sender's proof fee (the recipient needs no credits, and a receipt the submitter cannot take yet is sent on a later sync), the plain notices on what a proof makes public, a flag on a contact whose proof does not match the chain, deleting a sent file once the receipt arrives, paid tools choosing the funded network on their own, firm offers and recorded accepts with proof under one approval on the terms tools, and the testnet faucet hardening: a new claim waits while an earlier faucet payout is still pending, and payouts have a fee cap, a clearer text for a terms answer that was signed but whose record is still waiting (the status now matches what happened), a cap on error text and cleaner SSH keychain wording in the dogfood tools; setting up Cursor and Windsurf with `init`; free test credits claimed once per agent and test network when a proof first needs them; faucet and gas pool alerts; a hardened owner setup route for the local approval page, which refuses a seed that is not the shown owner (#424, #443); and the building blocks of a gasless test top-up (the signed authorisation and its relay checks, #448, #451), which is in progress and not available to use. Still open from M1a: the two-person dogfood between Tali and Denis (M1-23). Next in M1b: the designed approval page, sending files through the drop from the tools, adding credits through a pay page, and the 0.2.0 release.
> - **Does not exist yet:** the designed local approval page (a functional page with the owner code and a localhost passkey is merged, and `agentlink mcp` opens it when an approval is needed), the pay page for adding credits (the top-up link is built but off until it exists), the owner console, desktop apps and the cloud agent. They are described throughout and marked "planned" or "in development" where they are not available. Proof works on testnets only. v0.1.2 (the `@4thtech-io/agentlink` CLI and MCP server, pre-alpha) was released on 20 Oct 2026 and is the npm `latest`; install it with `npx -y @4thtech-io/agentlink init`.
> - **Next:** Send files through the encrypted drop from the tools (M1-13c), add `agentlink ui`, run the two-person dogfood, then finish M1b: the pay page for credits, the designed approval page and the 0.2.0 release.
>
> Every component, with its pull requests, is on the [status and roadmap page](docs-site/technical/project/status-and-roadmap.md). This section is generated from [`docs/status.yaml`](docs/status.yaml) (`node tools/docs-status/index.mjs`) and checked in CI.
<!-- status:end -->

## Roadmap

<!-- roadmap:start -->
| Milestone | What you can do at the end | Version |
|---|---|---|
| **M0 Foundations** (nearly complete) | Repository, CI and rules in place | 0.0.x |
| **M1a Walking skeleton: pair and talk** (v0.1.0 released 16 Oct 2026, v0.1.1 on 18 Oct, v0.1.2 on 20 Oct 2026; two-person dogfood open) | Two agents on different harnesses pair and talk; negotiate terms over Talk; owner approvals | 0.1.0 |
| **M1b Files, proof, credits** (started; file and proof tools in v0.1.2, submitter live on a testnet) | Send files with no setup; notarize on testnets with free test credits; export and verify proof packs; local approval UI; delivery receipts off by default and plain privacy disclosure for proofs (D-109) | 0.2.0 (M1 gate) |
| **M2 Owner console, desktop apps, self-host, design** | Owner console; desktop apps for macOS, Windows and Linux; self-hosted cloud agent; verify and invite pages; accept in the browser; verified registration and domains; storage connectors; proof privacy: per-relationship signing addresses, private registry, optional delayed receipts (D-109) | 0.3.0 |
| **M3 Mainnet beta (Base, Gnosis)** | External audit; contracts on Base and Gnosis; paid proof with credits | 1.0.0 |
| **M4 Expansion** | More chains; batched receipts; hosted remote MCP in approval mode (after design review); more adapters | after 1.0.0 |
| **M5 Agent commerce** | Deal records, payment linkage, arbitrator disclosure | after 1.0.0 |
| **M6 Solana** | Planned, no dates: after the EVM chains are covered, AgentLink on Solana, with programs equivalent to the notary and fee vault and client support (D-110); starts with a design spike | after M4 |
<!-- roadmap:end -->

Gates, progress and versioning: [status and roadmap](docs-site/technical/project/status-and-roadmap.md) and [versioning](docs/process/versioning.md).

## How it works

Your AI tool calls one MCP server that runs on your computer (or later in your own cloud account). It holds the keys and does all encryption. Everything outside your side may be malicious without exposing content or keys; at worst it can delay or withhold service.

```mermaid
flowchart LR
  subgraph You["Your side: keys live here"]
    H["AI tool"] -->|"MCP tools"| M["AgentLink MCP server + core"]
  end
  M -->|"encrypted messages"| R["Nostr relays"]
  M -->|"encrypted files (in development)"| D["Encrypted drop or your own storage"]
  M -.->|"signed records (in development)"| E["OCC v2 notary on Base and Gnosis"]
```

Messages are gift-wrapped Nostr events; files are encrypted in chunks before upload; proof is a signed hash on a public record with receipts from the recipient. More: [architecture](docs-site/technical/concepts/architecture.md), [design decisions](docs-site/technical/concepts/design-decisions.md) and [project overview](docs-site/technical/project/overview-and-principles.md) (why, use cases, free vs paid, principles, surfaces, repository map).

## Security and privacy

- **Zero access:** private keys, plaintext and file keys never reach any 4thTech service, relay or log.
- **Owner presence:** owner actions need your passkey or code; no MCP tool can approve, change rules or export keys.
- **Untrusted input:** messages from other agents are data, never instructions.
- **No project token.** Fees apply only to on-chain proof, shown in dollars first.

Read more: [what leaves your computer](docs-site/guide/privacy-and-security.md), the [security model](docs-site/technical/concepts/security-model.md) and the [threat model](docs-site/technical/concepts/threat-model.md). Report vulnerabilities privately: [SECURITY.md](SECURITY.md).

## Documentation

- **User guide** ([`docs-site/guide`](docs-site/guide/README.md)): set up, pair, approvals, FAQ. **Technical docs** ([`docs-site/technical`](docs-site/technical/README.md)): concepts, guides, reference. Both are published on GitBook from this repository.
- [`knowledge/`](knowledge/README.md) and [`llms.txt`](llms.txt): compact public knowledge base for AI assistants.
- [Networks and contract addresses](docs-site/technical/reference/networks-and-contracts.md): test networks, contract addresses and explorer links (Base Sepolia live; Gnosis Chiado live, smoke test pending; no mainnet).
- [`docs/`](docs/README.md): specifications, decisions and process. [`CHANGELOG.md`](CHANGELOG.md): releases.

## Contributing

Much of AgentLink is built by orchestrated AI agents under human review. See [CONTRIBUTING.md](CONTRIBUTING.md), and [AGENTS.md](AGENTS.md) if you are (or run) an agent. [Issues](https://github.com/4thtech/agentlink/issues) are open for feedback. Please follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE). The OCC v2 contracts are planned under BUSL-1.1 at mainnet (decision D-11). OCC v1 docs: [wiki.4thtech.io](https://wiki.4thtech.io).
