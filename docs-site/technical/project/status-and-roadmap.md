# Status and roadmap

<!-- status-hint:start -->
> **Status: Current as of 15 Oct 2026 (M0 Foundations, v0.0.1).** Derived from the [build plan](https://github.com/4thtech/agentlink/blob/main/docs/foundation/10-build-plan.md) and updated at every milestone. Durations are indicative, not commitments.
<!-- status-hint:end -->

## Where we are

<!-- status-summary:start -->
**Phase:** M0 Foundations nearly complete, M1a (walking skeleton) in progress (pre-alpha). The repository [README](https://github.com/4thtech/agentlink#status) carries the same status; both are generated from one source file, [`docs/status.yaml`](https://github.com/4thtech/agentlink/blob/main/docs/status.yaml).

**Not yet:** a usable product. The packages are private and nothing is published; only the crypto, types, transport, core and node foundations listed here contain code. **There is nothing to install or run yet.** The design is described throughout and marked "planned" where it is not built.

**Testnet:** OCC v2 notary and fee vault deployed and smoke-tested on 14 Oct 2026. Pre-audit; AgentLink does not use them yet. **Mainnet:** After the external audit (M3). Not deployed. **Services:** Submitter, faucet and encrypted drop are not built or deployed yet.

**In progress:** The rest of the crypto layer (file encryption) and the remaining contract work, the approvals queue and inbox sync in the core, the MCP server and CLI.

**Next:** The rest of the M1a crypto and core layers, then the walking skeleton where two agents on different harnesses pair and talk (v0.1.0); then M1b adds files, proof and credits on testnets.

### Components

Code that is merged is not necessarily published: nothing is released or installable yet.

| Area | Component | State | Pull requests |
|---|---|---|---|
| M0 Foundations | Monorepo skeleton | Done | - |
| M0 Foundations | Delivery pipeline and runbooks | Done | - |
| M0 Foundations | Public documentation structure | Done | - |
| M0 Foundations | Specifications and process | Done | - |
| M0 Foundations | Terms tools decision and CI follow-ups | In progress | - |
| Crypto (@agentlink/crypto) | Encodings, hashing, JSON canonicalisation | Done | [#27](https://github.com/4thtech/agentlink/pull/27) |
| Crypto (@agentlink/crypto) | Key derivation and public identities | Done | [#29](https://github.com/4thtech/agentlink/pull/29) |
| Crypto (@agentlink/crypto) | Envelope encryption | In progress | [#38](https://github.com/4thtech/agentlink/pull/38), [#61](https://github.com/4thtech/agentlink/pull/61) |
| Crypto (@agentlink/crypto) | EIP-712 typed data and the agent card | Done | [#32](https://github.com/4thtech/agentlink/pull/32) |
| Crypto (@agentlink/crypto) | Owner passphrase wrap, pairing proof, safety code | Done | [#37](https://github.com/4thtech/agentlink/pull/37) |
| Crypto (@agentlink/crypto) | Key interfaces, NIP-44 v2, gift wrap | Done | [#41](https://github.com/4thtech/agentlink/pull/41), [#42](https://github.com/4thtech/agentlink/pull/42), [#55](https://github.com/4thtech/agentlink/pull/55) |
| Crypto (@agentlink/crypto) | Independent test vectors | In progress | [#25](https://github.com/4thtech/agentlink/pull/25), [#35](https://github.com/4thtech/agentlink/pull/35), [#72](https://github.com/4thtech/agentlink/pull/72), [#75](https://github.com/4thtech/agentlink/pull/75) |
| Crypto (@agentlink/crypto) | File encryption (ALF1) | Planned | - |
| Shared types (@agentlink/types) | Constants and the envelope, payload, card and invite schemas | In progress | [#23](https://github.com/4thtech/agentlink/pull/23) |
| Shared types (@agentlink/types) | Policy, approval, proof pack and tool-result types | Done | [#31](https://github.com/4thtech/agentlink/pull/31), [#36](https://github.com/4thtech/agentlink/pull/36), [#71](https://github.com/4thtech/agentlink/pull/71), [#72](https://github.com/4thtech/agentlink/pull/72), [#76](https://github.com/4thtech/agentlink/pull/76) |
| Transport (@agentlink/transport-nostr) | Gift wrap and unwrap | Done | [#45](https://github.com/4thtech/agentlink/pull/45) |
| Transport (@agentlink/transport-nostr) | Relay pool and delivery outbox | Done | [#59](https://github.com/4thtech/agentlink/pull/59) |
| Transport (@agentlink/transport-nostr) | Sync | Done | [#63](https://github.com/4thtech/agentlink/pull/63) |
| Core (@agentlink/core) | Skeleton: identity, contacts, store and approval interfaces | Done | [#48](https://github.com/4thtech/agentlink/pull/48) |
| Core (@agentlink/core) | Envelopes | Done | [#66](https://github.com/4thtech/agentlink/pull/66) |
| Core (@agentlink/core) | Invites and pairing | Done | [#78](https://github.com/4thtech/agentlink/pull/78) |
| Core (@agentlink/core) | Safety code checked | Done | [#80](https://github.com/4thtech/agentlink/pull/80), [#85](https://github.com/4thtech/agentlink/pull/85) |
| Core (@agentlink/core) | Owner-signed actions and policies | Done | [#79](https://github.com/4thtech/agentlink/pull/79) |
| Core (@agentlink/core) | Approvals queue, inbox sync, relay changes | Planned | - |
| Node runtime (@agentlink/node) | Agent key store in the OS keychain | Done | [#54](https://github.com/4thtech/agentlink/pull/54), [#57](https://github.com/4thtech/agentlink/pull/57), [#83](https://github.com/4thtech/agentlink/pull/83) |
| Node runtime (@agentlink/node) | Local SQLite database | Done | [#60](https://github.com/4thtech/agentlink/pull/60), [#68](https://github.com/4thtech/agentlink/pull/68) |
| Node runtime (@agentlink/node) | Owner code at a prompt | Done | [#67](https://github.com/4thtech/agentlink/pull/67) |
| Node runtime (@agentlink/node) | Relay connection | Done | [#81](https://github.com/4thtech/agentlink/pull/81), [#84](https://github.com/4thtech/agentlink/pull/84) |
| Node runtime (@agentlink/node) | Policy version record in the keychain | Done | [#86](https://github.com/4thtech/agentlink/pull/86) |
| Node runtime (@agentlink/node) | Passphrase-locked key file for headless machines | Planned | - |
| MCP server, CLI and apps | MCP server and CLI | Planned | - |
| MCP server, CLI and apps | Local approval page | Planned | - |
| MCP server, CLI and apps | Owner console, desktop apps, cloud agent | Planned | - |
| OCC v2 contracts (private repo) | Notary and fee vault | Done | contracts#4 |
| OCC v2 contracts (private repo) | Testnet deployment | Done | [#65](https://github.com/4thtech/agentlink/pull/65), contracts#8, contracts#9 |
| OCC v2 contracts (private repo) | Gnosis Chiado deployment, ABI package, pre-audit fixes | Planned | - |
| Design | Design drop D1 | Done | [#33](https://github.com/4thtech/agentlink/pull/33) |
| Design | Design drop D2 | In progress | [#82](https://github.com/4thtech/agentlink/pull/82) |
<!-- status-summary:end -->

## Milestones

<!-- status-milestones:start -->
| Stage | What you can do at the end | Version | Indicative duration | Status |
|---|---|---|---|---|
| **M0** Foundations | Repository, CI and rules in place | 0.0.x | ~1 week | In progress |
| **M1a** Walking skeleton: pair and talk | Two agents on different harnesses pair and talk; negotiate terms over Talk; owner approvals | 0.1.0 | ~2–3 weeks | In progress |
| **M1b** Files, proof, credits | Send files with no setup; notarize on testnets with free test credits; export and verify proof packs; local approval UI | 0.2.0 (M1 gate) | ~3–4 weeks | Planned |
| **M2** Owner console, desktop apps, self-host, design | Owner console; desktop apps for macOS, Windows and Linux; self-hosted cloud agent; verify and invite pages; accept in the browser; verified registration and domains; storage connectors | 0.3.0 | ~4–6+ weeks | Planned |
| **M3** Mainnet beta (Base, Gnosis) | External audit; contracts on Base and Gnosis; paid proof with credits | 1.0.0 | ~4 weeks | Planned |
| **M4** Expansion | More chains; batched receipts; hosted remote MCP in approval mode (after design review); more adapters | after 1.0.0 | rolling | Planned |
| **M5** Agent commerce | Deal records, payment linkage, arbitrator disclosure | after 1.0.0 | rolling | Planned |
<!-- status-milestones:end -->

## Gates

- **M1a:** the two lead developers' agents pair and sync project status through AgentLink, and complete a negotiation over Talk without on-chain proof.
- **M1:** 10 internal testers on at least 3 harness combinations complete install, first message, notarized handover, approvals, verification and a proof of agreement on testnets; no crypto vocabulary in default flows; install to first message under 5 minutes.
- **M2:** 20 to 50 external testers on testnets; the same UX bar, including the desktop apps and the browser counterparty.
- **M3:** first paid notarizations; zero security incidents; an external audit of the contracts with all high and medium findings fixed.

## The nine building blocks

| # | Block | First milestone |
|---|---|---|
| 1 | Crypto | M1a |
| 2 | Messaging (Nostr relays) | M1a |
| 3 | Core (pairing, contacts, threads, policies, approvals) | M1a |
| 4 | Local node (OS keychain, local database) | M1a |
| 5 | MCP server and CLI | M1a |
| 6 | Files (encrypted drop, own storage) | M1b |
| 7 | Proof (contracts, chain client, submitter) | M1b |
| 8 | Apps (local approval UI, then console and desktop apps) | M1b, M2 |
| 9 | Cloud agent (self-host) | M2 |

## Not in the beta

A human chat app, real-time chat, readable file hosting or archiving, custody of funds or keys, a project token, payments between parties (later), and forward secrecy for archived messages.
