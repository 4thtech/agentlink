# AgentLink knowledge base

This folder is the public, compressed knowledge base for AgentLink by 4thTech. It is written for AI assistants (for example the chat support on the future AgentLink website, fed through Lumina) and for human readers, and it is also the source for social posts. Each file stands on its own and owns its facts: a fact is stated once, in the file that owns it, because the whole folder is loaded into the chat's context on every answer.

Last reviewed: 17 October 2026. Project phase: pre-alpha. The first usable version (v0.1.0, M1a) was released on 16 Oct 2026 and installs with `npx -y @4thtech-io/agentlink init`; files, proof and the apps are not built yet.

The folder follows the pattern of The Curator's `llm-docs/`: few files, each with a clear owner role, headings written as the question a visitor would type.

## Files

| File | Owns |
|---|---|
| [agentlink-overview.md](https://github.com/4thtech/agentlink/blob/main/knowledge/agentlink-overview.md) | What AgentLink is, who it is for, principles, pricing, status and roadmap (generated block), FAQ, glossary, the company |
| [agentlink-userguide.md](https://github.com/4thtech/agentlink/blob/main/knowledge/agentlink-userguide.md) | Install per AI tool, owner setup, pairing, messages, approvals, terms, troubleshooting |
| [agentlink-security-and-privacy.md](https://github.com/4thtech/agentlink/blob/main/knowledge/agentlink-security-and-privacy.md) | What 4thTech can and cannot see, and the honest limits |
| [agentlink-technical.md](https://github.com/4thtech/agentlink/blob/main/knowledge/agentlink-technical.md) | Packages, MCP server, Nostr transport, encryption, store, the OCC v2 protocol and contracts, technical glossary |

Planned later, not needed yet: a site map (when the AgentLink marketing site exists) and a reading file (articles and research). The machine-readable index for AI tools is [llms.txt](https://github.com/4thtech/agentlink/blob/main/llms.txt) at the repository root.

## Maintenance rule

Update these files on every valuable or user-visible change, in the same pull request that makes the change: a new or changed command, supported AI tool, feature, price, limit, security property or milestone, and every release. This is enforced by the docs process (the "Docs and knowledge" step of the delivery process and the docs pass in the development process) and by the "Docs impact" section of every pull request.

- **Status is generated.** `docs/status.yaml` is the single source. `node tools/docs-status/index.mjs` regenerates the marked status blocks in `agentlink-overview.md`; the check runs in `pnpm lint` and fails on drift. Do not edit those blocks by hand.
- **Never claim something that is not built.** Anything not yet available is labelled "planned" or "in development", with the version where it is expected. Where this folder and the specifications differ, the specifications win.
- **Move, do not duplicate.** Put a fact in the file that owns it; cut rather than append.
- **Plain language.** Follow the vocabulary rules of `docs/foundation/11-claude-design-brief.md` §5: no "wallet", "gas", "seed phrase" or "transaction" in user-facing text. Blockchain terms appear only where needed, and are explained.
- **Public-safe.** No secrets, no contract addresses, no details of unfixed vulnerabilities.
- **Shape.** One `#` heading per file, `##` headings written as the question a visitor would type, plain markdown only.
- Report a mistake by opening an issue at https://github.com/4thtech/agentlink/issues. Report a security problem privately, as described in [SECURITY.md](https://github.com/4thtech/agentlink/blob/main/SECURITY.md).

## Size budget

The whole knowledge base (`llms.txt` plus every file in this folder) is loaded into the chat's context on every answer, so its size costs money.

- **Soft target:** 30,000 tokens in total (a warning above it). **Hard maximum:** 80,000 tokens (a failure above it).
- **Method:** tokens are estimated as bytes divided by 4, rounded up. `node tools/check-knowledge-size.mjs` (part of `pnpm lint`) prints each file's estimate, warns above the target and fails above the hard maximum. `node tools/check-knowledge-links.mjs` resolves every link: relative links must exist in the repository, absolute links into `github.com/4thtech/agentlink/blob/main/` must point to existing paths, and `TBD: wiki link after redesign` placeholders are allowed and counted.
- Prefer tightening over growth: when adding something, remove or shorten something else.
