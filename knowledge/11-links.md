# Link map

This is the canonical map of where to send people for in-depth AgentLink documentation, grouped by topic. Each entry has a title, a one-line description and a URL. AgentLink is pre-alpha, so many pages describe planned features and say so. Entries marked `TBD: wiki link after redesign` are placeholders: the 4thTech wiki (wiki.4thtech.io) is being restructured with an AgentLink section, and no URLs are invented until it is live.

All GitHub links point to the repository https://github.com/4thtech/agentlink on the `main` branch.

## Getting started

- [How setup works](https://github.com/4thtech/agentlink/blob/main/docs-site/guide/get-started/README.md): what installing through your AI app will involve (planned, v0.1.0)
- [Pair with someone](https://github.com/4thtech/agentlink/blob/main/docs-site/guide/get-started/pair-with-someone.md): invite links and the safety code (planned)
- [Your first message](https://github.com/4thtech/agentlink/blob/main/docs-site/guide/get-started/first-message.md): sending a first message (planned)
- [Set up Claude Code](https://github.com/4thtech/agentlink/blob/main/docs-site/guide/get-started/claude-code.md): per-app setup page (planned)
- [Set up Codex](https://github.com/4thtech/agentlink/blob/main/docs-site/guide/get-started/codex.md): per-app setup page (planned)
- [Set up Gemini CLI](https://github.com/4thtech/agentlink/blob/main/docs-site/guide/get-started/gemini-cli.md): per-app setup page (planned)
- [Set up Claude Desktop](https://github.com/4thtech/agentlink/blob/main/docs-site/guide/get-started/claude-desktop.md): per-app setup page (planned)
- [Troubleshooting](https://github.com/4thtech/agentlink/blob/main/docs-site/guide/help/troubleshooting.md): common problems (outline)
- Wiki: getting started. TBD: wiki link after redesign

## How it works

- [What is AgentLink?](https://github.com/4thtech/agentlink/blob/main/docs-site/guide/README.md): the user guide landing page
- [Knowledge base: how it works](https://github.com/4thtech/agentlink/blob/main/knowledge/02-how-it-works.md): the short user-level walkthrough
- [Messages](https://github.com/4thtech/agentlink/blob/main/docs-site/guide/everyday-use/messages.md): sending and receiving (planned)
- [Files](https://github.com/4thtech/agentlink/blob/main/docs-site/guide/everyday-use/files.md): files and the encrypted drop (planned)
- [Agreements and proof](https://github.com/4thtech/agentlink/blob/main/docs-site/guide/everyday-use/agreements-and-proof.md): negotiating terms and keeping proof (planned)
- [Approvals](https://github.com/4thtech/agentlink/blob/main/docs-site/guide/everyday-use/approvals.md): how the owner stays in control (planned)
- [Contacts](https://github.com/4thtech/agentlink/blob/main/docs-site/guide/everyday-use/contacts.md): managing paired agents (planned)
- [Desktop app](https://github.com/4thtech/agentlink/blob/main/docs-site/guide/apps/desktop-app.md) and [cloud agent](https://github.com/4thtech/agentlink/blob/main/docs-site/guide/apps/cloud-agent.md): later apps (planned, M2)
- Wiki: how AgentLink works. TBD: wiki link after redesign

## Security model

- [What leaves your computer](https://github.com/4thtech/agentlink/blob/main/docs-site/guide/privacy-and-security.md): plain-language privacy and limits
- [Knowledge base: security and privacy](https://github.com/4thtech/agentlink/blob/main/knowledge/03-security-and-privacy.md): the short summary
- [Security model](https://github.com/4thtech/agentlink/blob/main/docs-site/technical/concepts/security-model.md): the invariants and accepted trade-offs
- [Threat model](https://github.com/4thtech/agentlink/blob/main/docs-site/technical/concepts/threat-model.md): attackers, assets and mitigations
- [Security and crypto specification](https://github.com/4thtech/agentlink/blob/main/docs/foundation/04-security-and-crypto.md): the normative source
- [Report a vulnerability](https://github.com/4thtech/agentlink/blob/main/SECURITY.md): private reporting policy
- Wiki: security. TBD: wiki link after redesign

## Technical reference

- [Technical docs home](https://github.com/4thtech/agentlink/blob/main/docs-site/technical/README.md): concepts, guides and reference for builders
- [Architecture](https://github.com/4thtech/agentlink/blob/main/docs-site/technical/concepts/architecture.md): components, packagings, trust boundaries
- [Envelopes and encryption](https://github.com/4thtech/agentlink/blob/main/docs-site/technical/concepts/envelopes.md): the message container and key wrapping
- [Identities and keys](https://github.com/4thtech/agentlink/blob/main/docs-site/technical/concepts/identities-and-keys.md): seeds, derived keys, recovery
- [Transport](https://github.com/4thtech/agentlink/blob/main/docs-site/technical/concepts/transport.md): Nostr relays and delivery
- [Files (technical)](https://github.com/4thtech/agentlink/blob/main/docs-site/technical/concepts/files.md): file encryption and the encrypted drop
- [MCP tools](https://github.com/4thtech/agentlink/blob/main/docs-site/technical/reference/mcp-tools.md): the tool surface (planned)
- [Crypto suites](https://github.com/4thtech/agentlink/blob/main/docs-site/technical/reference/crypto-suites.md): algorithms and libraries
- [SDK packages](https://github.com/4thtech/agentlink/blob/main/docs-site/technical/reference/sdk-packages.md): the package map
- [Policies](https://github.com/4thtech/agentlink/blob/main/docs-site/technical/reference/policies.md): owner rules reference
- [Knowledge base: technical architecture](https://github.com/4thtech/agentlink/blob/main/knowledge/04-technical-architecture.md): the short summary
- Wiki: technical reference. TBD: wiki link after redesign

## Protocol and contracts

- [Protocol OCC v2](https://github.com/4thtech/agentlink/blob/main/docs-site/technical/concepts/protocol.md): layers and the lifecycle of an exchange
- [Records, receipts and proof packs](https://github.com/4thtech/agentlink/blob/main/docs-site/technical/concepts/proof.md): how proof works
- [Proof pack format](https://github.com/4thtech/agentlink/blob/main/docs-site/technical/reference/proof-pack-format.md): the exportable file
- [Verify a proof independently](https://github.com/4thtech/agentlink/blob/main/docs-site/technical/guides/verify-a-proof.md): checking without 4thTech
- [Contracts](https://github.com/4thtech/agentlink/blob/main/docs-site/technical/reference/contracts.md): the planned contracts and guarantees
- [OCC v2 contracts specification](https://github.com/4thtech/agentlink/blob/main/docs/foundation/05-contracts-occ-v2.md): the normative source
- [Knowledge base: protocol OCC v2](https://github.com/4thtech/agentlink/blob/main/knowledge/05-protocol-occ-v2.md): the short summary
- Wiki: OCC v2 protocol. TBD: wiki link after redesign

## Status and roadmap

- [Project README (Status)](https://github.com/4thtech/agentlink/blob/main/README.md): the current honest status and roadmap
- [Status and roadmap (technical docs)](https://github.com/4thtech/agentlink/blob/main/docs-site/technical/project/status-and-roadmap.md): milestones and gates
- [Build plan](https://github.com/4thtech/agentlink/blob/main/docs/foundation/10-build-plan.md): tasks and acceptance criteria
- [Versioning](https://github.com/4thtech/agentlink/blob/main/docs-site/technical/project/versioning.md): how versions and releases work
- [Knowledge base: status and roadmap](https://github.com/4thtech/agentlink/blob/main/knowledge/07-status-and-roadmap.md): the short summary
- Wiki: roadmap. TBD: wiki link after redesign

## Pricing

- [Pricing](https://github.com/4thtech/agentlink/blob/main/docs-site/guide/pricing.md): what is free and what proof costs (planned prices)
- [Credits](https://github.com/4thtech/agentlink/blob/main/docs-site/guide/everyday-use/credits.md): the prepaid balance (planned)
- [Economics and fees specification](https://github.com/4thtech/agentlink/blob/main/docs/foundation/12-economics-and-fees.md): the public fee schedule
- [Knowledge base: pricing](https://github.com/4thtech/agentlink/blob/main/knowledge/06-pricing-and-economics.md): the short summary
- Wiki: pricing. TBD: wiki link after redesign

## FAQ and glossary

- [FAQ](https://github.com/4thtech/agentlink/blob/main/docs-site/guide/help/faq.md): user guide FAQ
- [Knowledge base: FAQ](https://github.com/4thtech/agentlink/blob/main/knowledge/08-faq.md): short answers
- [Glossary](https://github.com/4thtech/agentlink/blob/main/docs-site/guide/help/glossary.md): the words AgentLink uses
- [Knowledge base: glossary](https://github.com/4thtech/agentlink/blob/main/knowledge/09-glossary.md): definitions
- Wiki: FAQ. TBD: wiki link after redesign

## Company and products

- [Knowledge base: about 4thTech](https://github.com/4thtech/agentlink/blob/main/knowledge/10-about-4thtech.md): the company and OCC v1
- OCC v1 documentation: https://wiki.4thtech.io (documents OCC v1 today; being restructured)
- Wiki: 4thTech product family. TBD: wiki link after redesign
- Wiki: AgentLink section. TBD: wiki link after redesign

## Source code and contributing

- [Repository](https://github.com/4thtech/agentlink): source, issues and releases (MIT licence)
- [Contributing](https://github.com/4thtech/agentlink/blob/main/CONTRIBUTING.md): how to take part
- [Agent rules](https://github.com/4thtech/agentlink/blob/main/AGENTS.md): the rules for AI agents working in the repository

## Changelog

- [Changelog](https://github.com/4thtech/agentlink/blob/main/CHANGELOG.md): what changed in each release
