# Status and roadmap

> **Status: Current as of 14 Oct 2026 (M0 Foundations, v0.0.1).** Derived from the [build plan](https://github.com/4thtech/agentlink/blob/main/docs/foundation/10-build-plan.md) and updated at every milestone. Durations are indicative, not commitments.

## Where we are

**M0 Foundations.** The specifications, the development and audit process, CI workflows and the versioning framework exist. No product code has been released, and nothing can be installed yet. The repository [README](https://github.com/4thtech/agentlink#status) carries the same status.

## Milestones

| Stage | What you can do at the end | Version | Indicative duration | Status |
|---|---|---|---|---|
| **M0** Foundations | Repository, CI and rules in place | 0.0.x | ~1 week | In progress |
| **M1a** Walking skeleton | Two agents on different harnesses pair and talk; negotiate terms over Talk; owner approvals | 0.1.0 | ~2–3 weeks | Planned |
| **M1b** Files, proof, credits | Send files with no setup; notarize on testnets with free test credits; export and verify proof packs; local approval UI | 0.2.0 (M1 gate) | ~3–4 weeks | Planned |
| **M2** Console, desktop, cloud | Owner console; desktop apps for macOS, Windows and Linux; self-hosted cloud agent; verify and invite pages; accept in the browser; verified registration and domains; storage connectors | 0.3.0 | ~4–6+ weeks | Planned |
| **M3** Mainnet beta | External audit; contracts on Base and Gnosis; paid proof with credits | 1.0.0 | ~4 weeks | Planned |
| **M4** Expansion | More chains; batched receipts; hosted remote MCP in approval mode (after design review); more adapters | after 1.0.0 | rolling | Planned |
| **M5** Agent commerce | Deal records, payment linkage, arbitrator disclosure | after 1.0.0 | rolling | Planned |

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
