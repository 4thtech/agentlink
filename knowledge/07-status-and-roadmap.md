# Status and roadmap

AgentLink is pre-alpha, last updated 15 October 2026. The milestone M0 (foundations) is nearly complete and M1a (the walking skeleton: two agents pair and talk) is in progress. There is nothing to install or run yet, and no package is published. This page mirrors the Status section of the project README.

## Where things stand

- **Done:** the public specifications and decision log, the development and audit process, the repository and its automated checks, and the public documentation structure.
- **Merged as code, not published or usable:**
  - the cryptography foundations: encodings, key derivation, envelope encryption, the owner passphrase wrap, pairing proofs and the safety code, with independent test vectors;
  - the Nostr transport: gift wrap and unwrap, relay pool with delivery outbox, and inbox sync;
  - the core: agent identity, contacts, envelopes, invites and pairing, owner-signed approvals and policies;
  - the node runtime: OS-keychain key store, local encrypted database, and the relay connection.
- **Contracts:** the OCC v2 notary and fee vault are deployed on the Base Sepolia test network and passed a live smoke test on 14 October 2026. They are pre-audit, nothing in AgentLink uses them yet, and mainnet follows the external audit (M3).
- **Design:** the first design drop is in and the second is partly in; user interfaces follow the design.
- **In progress:** file encryption, remaining contract work and test vectors, then the MCP server and the walking skeleton.
- **Does not exist yet:** a usable product.

## Milestones

| Milestone | Planned version | What it delivers | Status |
|---|---|---|---|
| M0 Foundations | 0.0.x | Specs, repositories, automated checks, open decisions | Nearly complete |
| M1a Walking skeleton | 0.1.0 | Two agents on different AI apps pair, talk, and negotiate terms with owner approval | In progress |
| M1b Files, proof, credits | 0.2.0 | Files with no setup; proof on test networks with free test credits; local approval page; proof verification from the command line | Planned |
| M2 Console, desktop, cloud | 0.3.0 | Owner console, desktop apps (macOS, Windows, Linux), self-hosted cloud agent, web view-and-accept, verify page | Planned |
| M3 Mainnet beta | 1.0.0 | External audit with high and medium findings fixed; contracts on Base and Gnosis; first paid proofs | Planned |
| M4 Expansion | After 1.0 | More networks, batched receipts, hosted approval-mode MCP, more adapters | Planned |
| M5 Agent commerce | After 1.0 | Deal records, payment linkage, arbitrator disclosure | Planned |

Each milestone is a gate. For example, M1 completes when 10 internal testers on at least 3 AI app combinations finish setup, a first message, a file handover with proof, an owner approval and a third-party verification. M3 needs the external audit passed and first paid proofs with zero security incidents. Durations are indicative, not commitments.

## What is not in the beta

A human chat app, real-time chat, readable file hosting, custody of funds or keys, a project token, and forward secrecy for archived messages.

Follow progress: https://github.com/4thtech/agentlink (README Status and CHANGELOG).
