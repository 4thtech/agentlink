# AgentLink knowledge base

This folder is the public, compressed knowledge base for AgentLink by 4thTech. It is written for AI assistants (for example the chat on the AgentLink website) and for human readers who want accurate answers fast. Each file stands on its own, so it can be retrieved and read without the others.

Last reviewed: 15 October 2026. Project phase: pre-alpha. Nothing can be installed yet.

## Why it exists

AgentLink is built in public, and its full specifications are long. This folder is the short, canonical summary: what AgentLink is, how it is designed to work, what it protects, what it costs, and where the project honestly stands today. The full detail lives in the [public docs](https://github.com/4thtech/agentlink/blob/main/docs-site/README.md) and the [specifications](https://github.com/4thtech/agentlink/blob/main/docs/foundation/00-README.md); where they differ from this folder, the specifications win.

## How it is maintained

- It is updated in the same change as every milestone or release (the docs step of the delivery process), and files 04 and 07 are also updated whenever the README Status changes materially, so they do not drift between milestones. The README Status is the live source.
- [11-links.md](https://github.com/4thtech/agentlink/blob/main/knowledge/11-links.md) must be updated whenever the `docs-site/` or the 4thTech wiki structure changes. The check script verifies every link in the knowledge base (see below) and counts the remaining wiki placeholders.
- It never claims something that is not built. Anything not yet available is labelled "planned" or "in development", with the version where it is expected.
- It uses plain language. Blockchain terms appear only where they are needed, and are explained.
- It contains no private material: no secrets, no contract addresses, no details of unfixed vulnerabilities.
- Report a mistake by opening an issue at https://github.com/4thtech/agentlink/issues. Report a security problem privately, as described in [SECURITY.md](https://github.com/4thtech/agentlink/blob/main/SECURITY.md).

## Size budget

The whole knowledge base (`llms.txt` plus every file in this folder) is loaded into the chat's context on every answer, so its size costs money.

- **Soft target:** 30,000 tokens in total (a warning above it; the knowledge base is expected to grow). **Hard maximum:** 80,000 tokens (a failure above it).
- **Method:** tokens are estimated as bytes divided by 4, rounded up. The check `node tools/check-knowledge-size.mjs` (part of `pnpm lint`) prints each file's estimate, warns above the target and fails above the hard maximum. The same check also resolves every link: relative links must exist in the repository, absolute links into `github.com/4thtech/agentlink/blob/main/` must point to existing paths, and `TBD: wiki link after redesign` placeholders are allowed and counted.
- Prefer tightening over growth: when adding something, remove or shorten something else.
- Each file states its purpose in its first sentence or two.

## Files

| File | What it covers |
|---|---|
| [01-overview.md](https://github.com/4thtech/agentlink/blob/main/knowledge/01-overview.md) | What AgentLink is, who it is for, why it exists |
| [02-how-it-works.md](https://github.com/4thtech/agentlink/blob/main/knowledge/02-how-it-works.md) | Setup, pairing, messages, files and proof, from a user's view |
| [03-security-and-privacy.md](https://github.com/4thtech/agentlink/blob/main/knowledge/03-security-and-privacy.md) | What 4thTech can and cannot see, and the honest limits |
| [04-technical-architecture.md](https://github.com/4thtech/agentlink/blob/main/knowledge/04-technical-architecture.md) | Packages, MCP server, Nostr transport, encryption, store |
| [05-protocol-occ-v2.md](https://github.com/4thtech/agentlink/blob/main/knowledge/05-protocol-occ-v2.md) | The OCC v2 protocol: records, receipts, contracts, licences |
| [06-pricing-and-economics.md](https://github.com/4thtech/agentlink/blob/main/knowledge/06-pricing-and-economics.md) | What is free, what is paid, planned prices |
| [07-status-and-roadmap.md](https://github.com/4thtech/agentlink/blob/main/knowledge/07-status-and-roadmap.md) | Where the project stands today and the milestones ahead |
| [08-faq.md](https://github.com/4thtech/agentlink/blob/main/knowledge/08-faq.md) | Short answers to common questions |
| [09-glossary.md](https://github.com/4thtech/agentlink/blob/main/knowledge/09-glossary.md) | Definitions of the terms used |
| [10-about-4thtech.md](https://github.com/4thtech/agentlink/blob/main/knowledge/10-about-4thtech.md) | The company and its earlier protocol |
| [11-links.md](https://github.com/4thtech/agentlink/blob/main/knowledge/11-links.md) | The canonical link map to in-depth docs, by topic |

The machine-readable index for AI tools is [llms.txt](https://github.com/4thtech/agentlink/blob/main/llms.txt) at the repository root.
