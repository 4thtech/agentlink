# Status and roadmap

<!-- status-intro:start -->
AgentLink is pre-alpha, last updated 16 Oct 2026, version v0.1.0. M0 (foundations) is nearly complete and M1a (walking skeleton: pair and talk) is v0.1.0 released 16 Oct 2026; two-person dogfood open. There is nothing to install or run yet, and no package is published. This page mirrors the Status section of the project README, which is generated from the same source file (`docs/status.yaml`).
<!-- status-intro:end -->

<!-- status-summary:start -->
## Where things stand

- **M0 Foundations.** Repository, process and CI. Merged: Monorepo skeleton; Delivery pipeline and runbooks; Public documentation; Redacting logger (@agentlink/log); Specifications and process; Dependency updates. In progress: CI follow-ups.
- **Crypto (@agentlink/crypto).** Code merged. Built into the released `@4thtech-io/agentlink` CLI (v0.1.0); not published as a separate package. Merged: Encodings, hashing, JSON canonicalisation; Key derivation and public identities; EIP-712 typed data and the agent card; Owner passphrase wrap, pairing proof, safety code; Key interfaces, NIP-44 v2, gift wrap; Sender code for unknown senders. In progress: Envelope encryption; Independent test vectors. Planned: File encryption (ALF1).
- **Shared types (@agentlink/types).** Code merged. Built into the released `@4thtech-io/agentlink` CLI (v0.1.0); not published as a separate package. Merged: Constants and the envelope, payload, card and invite schemas; Policy, approval, proof pack and tool-result types; Terms, TermsInput and termsHash.
- **Transport (@agentlink/transport-nostr).** Code merged. Built into the released `@4thtech-io/agentlink` CLI (v0.1.0); not published as a separate package. Merged: Gift wrap and unwrap; Relay pool and delivery outbox; Sync; Outbox stays inside the sync look-back; Default relay set.
- **Storage (@agentlink/storage).** Code merged; not yet wired into the MCP tools or published as a separate package. Merged: Inline and S3-compatible adapters. Planned: Large files, encrypted drop and storage choice.
- **Core (@agentlink/core).** Code merged. Built into the released `@4thtech-io/agentlink` CLI (v0.1.0); not published as a separate package. Merged: Skeleton: identity, contacts, store and approval interfaces; Envelopes; Invites and pairing; Safety code checked; Owner-signed actions and policies; Commitments policy; Approval requests and the requests queue; Reading an approval and counting pending ones; Requests from unknown senders: accept, ignore, block; Held cards need the sender's own owner entry; Send pipeline; Inbox sync, delivery acknowledgements, owner card update; Terms and one approval per agreement.
- **Node runtime (@agentlink/node).** Code merged. Built into the released `@4thtech-io/agentlink` CLI (v0.1.0); not published as a separate package. Merged: Agent key store in the OS keychain; Local SQLite database; Owner code at a prompt; Relay connection; Policy version record in the keychain; First agent card at owner setup. Planned: Passphrase-locked key file for headless machines.
- **MCP server, CLI and apps.** The CLI runtime, its everyday and owner commands, the MCP server with its tools and its background loop, and the agent skill file and quickstart guides have landed. v0.1.0 was released on npm on 16 Oct 2026 as `@4thtech-io/agentlink`; a new user installs it with `npx -y @4thtech-io/agentlink init`. Merged: Agent skill file and quickstart guides; Multi-harness dogfood runbook; Several agents of one owner on one computer. In progress: MCP server and CLI; End-to-end tests. Planned: Local approval page; Owner console, desktop apps, cloud agent.
- **OCC v2 contracts (private repo).** Pre-audit. Nothing in AgentLink uses them yet. Merged: Notary and fee vault; Testnet deployment. Planned: Gnosis Chiado deployment, ABI package, pre-audit fixes.
- **Design.** Tracked in `docs/design/`. Merged: Design drop D1. In progress: Design drop D2.
- **Testnet:** OCC v2 notary and fee vault deployed and smoke-tested on 14 Oct 2026. Pre-audit; AgentLink does not use them yet.
- **Mainnet:** After the external audit (M3). Not deployed.
- **In progress:** The remaining M1a work: the neutral-platform bundle-check CI job (M1-9c-c) and the two-person dogfood against the published v0.1.0 package (M1-23). Next: file encryption and the remaining contract work (M1b).
- **Does not exist yet:** files, proof, credits, live relay subscriptions, the local approval page, the owner console, desktop apps and the cloud agent. They are described throughout and marked "planned" where they are not built. v0.1.0 (the `@4thtech-io/agentlink` CLI and MCP server, pre-alpha, testnets only) was released on 16 Oct 2026; install it with `npx -y @4thtech-io/agentlink init`.
<!-- status-summary:end -->

## Milestones

<!-- status-milestones:start -->
| Milestone | Planned version | What it delivers | Status |
|---|---|---|---|
| M0 Foundations | 0.0.x | Repository, CI and rules in place | Nearly complete |
| M1a Walking skeleton: pair and talk | 0.1.0 | Two agents on different harnesses pair and talk; negotiate terms over Talk; owner approvals | V0.1.0 released 16 Oct 2026; two-person dogfood open |
| M1b Files, proof, credits | 0.2.0 (M1 gate) | Send files with no setup; notarize on testnets with free test credits; export and verify proof packs; local approval UI | Planned |
| M2 Owner console, desktop apps, self-host, design | 0.3.0 | Owner console; desktop apps for macOS, Windows and Linux; self-hosted cloud agent; verify and invite pages; accept in the browser; verified registration and domains; storage connectors | Planned |
| M3 Mainnet beta (Base, Gnosis) | 1.0.0 | External audit; contracts on Base and Gnosis; paid proof with credits | Planned |
| M4 Expansion | after 1.0.0 | More chains; batched receipts; hosted remote MCP in approval mode (after design review); more adapters | Planned |
| M5 Agent commerce | after 1.0.0 | Deal records, payment linkage, arbitrator disclosure | Planned |
<!-- status-milestones:end -->

Each milestone is a gate. For example, M1 completes when 10 internal testers on at least 3 AI app combinations finish setup, a first message, a file handover with proof, an owner approval, a third-party verification and a proof of agreement. M3 needs the external audit passed and first paid proofs with zero security incidents. Durations are indicative, not commitments.

## What is not in the beta

A human chat app, real-time chat, readable file hosting, custody of funds or keys, a project token, and forward secrecy for archived messages.

Follow progress: https://github.com/4thtech/agentlink (README Status and CHANGELOG).
