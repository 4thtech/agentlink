# AgentLink knowledge base

This folder is the public, compressed knowledge base for AgentLink by 4thTech. It is written for AI assistants (for example the chat on the AgentLink website) and for human readers who want accurate answers fast. Each file stands on its own, so it can be retrieved and read without the others.

Last reviewed: 15 October 2026. Project phase: pre-alpha. Nothing can be installed yet.

## Why it exists

AgentLink is built in public, and its full specifications are long. This folder is the short, canonical summary: what AgentLink is, how it is designed to work, what it protects, what it costs, and where the project honestly stands today. The full detail lives in the [public docs](../docs-site/README.md) and the [specifications](../docs/foundation/00-README.md); where they differ from this folder, the specifications win.

## How it is maintained

- It is updated in the same change as every milestone or release (the docs step of the delivery process).
- It never claims something that is not built. Anything not yet available is labelled "planned" or "in development", with the version where it is expected.
- It uses plain language. Blockchain terms appear only where they are needed, and are explained.
- It contains no private material: no secrets, no contract addresses, no details of unfixed vulnerabilities.
- Report a mistake by opening an issue at https://github.com/4thtech/agentlink/issues. Report a security problem privately, as described in [SECURITY.md](../SECURITY.md).

## Files

| File | What it covers |
|---|---|
| [01-overview.md](01-overview.md) | What AgentLink is, who it is for, why it exists |
| [02-how-it-works.md](02-how-it-works.md) | Setup, pairing, messages, files and proof, from a user's view |
| [03-security-and-privacy.md](03-security-and-privacy.md) | What 4thTech can and cannot see, and the honest limits |
| [04-technical-architecture.md](04-technical-architecture.md) | Packages, MCP server, Nostr transport, encryption, store |
| [05-protocol-occ-v2.md](05-protocol-occ-v2.md) | The OCC v2 protocol: records, receipts, contracts, licences |
| [06-pricing-and-economics.md](06-pricing-and-economics.md) | What is free, what is paid, planned prices |
| [07-status-and-roadmap.md](07-status-and-roadmap.md) | Where the project stands today and the milestones ahead |
| [08-faq.md](08-faq.md) | Short answers to common questions |
| [09-glossary.md](09-glossary.md) | Definitions of the terms used |
| [10-about-4thtech.md](10-about-4thtech.md) | The company and its earlier protocol |

The machine-readable index for AI tools is [llms.txt](../llms.txt) at the repository root.
