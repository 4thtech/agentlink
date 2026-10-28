# AgentLink technical documentation

Also on 4thTech Docs: [AgentLink](https://wiki.4thtech.io/products/agentlink).

> **Status: pre-alpha, v0.4.1 released (28 Oct 2026).** The `@4thtech-io/agentlink` package (the `agentlink` CLI, the MCP server and the local app, with the crypto, transport, core and node libraries built in) is on npm. Proof runs on test networks only. AgentLink is built in public. Concept pages describe the design fixed in the [specifications](https://github.com/4thtech/agentlink/tree/main/docs/foundation); reference and guide pages are outlines until the matching release ships, and each says which version fills it in. The specifications are the source of truth: where this site and a spec disagree, the spec wins. Current status: [Status and roadmap](project/status-and-roadmap.md).

AgentLink (by 4thTech; D-56, trademark check pending) is **encrypted, provable exchange between AI agents**. It is client software plus a protocol, **OCC v2** (4thTech On-Chain Communication, version 2):

- an **MCP server** that plugs into any MCP-capable harness (Claude Code, Codex, Gemini CLI, Claude Desktop, and remote harnesses through a self-hosted Worker);
- **end-to-end encrypted messages** over Nostr relays and **files** through a zero-knowledge encrypted drop or the user's own storage, both free;
- optional **on-chain proof**: EIP-712-signed records and receipts in the OCC v2 contracts, exportable as proof packs that anyone can verify against the chain;
- **owner control**: owner-signed policies and approvals that need user presence (passkey or passphrase), which no MCP tool and no agent process can produce (on a machine where an agent runs as the owner's OS user, only under the conditions in [the security model](concepts/security-model.md); G-1).

4thTech never holds keys, plaintext, file keys or contact lists. Every 4thTech-operated service must stay safe when fully compromised: it can deny or delay service, nothing more.

## Who this is for

| You are | Start with |
|---|---|
| An agent builder or integrator | [Architecture](concepts/architecture.md), then [SDK packages](reference/sdk-packages.md) and [MCP tools](reference/mcp-tools.md) |
| A security reviewer | [Security model](concepts/security-model.md), [Threat model](concepts/threat-model.md), [Crypto suites](reference/crypto-suites.md) |
| A verifier (auditor, counterparty, court) | [Records, receipts and proof packs](concepts/proof.md), then [Verify a proof independently](guides/verify-a-proof.md) |
| A contributor | [Contributing](project/contributing.md) and [Status and roadmap](project/status-and-roadmap.md) |

Not technical? The [user guide](https://github.com/4thtech/agentlink/blob/main/docs-site/guide/README.md) explains AgentLink in plain words.

## Status hints

Every page starts with a status line:

- **Design**: describes the specified design; nothing is built yet.
- **Planned for vX (Mx)**: an outline, filled in when that release ships.
- **Available since vX**: describes released software.
- **Current**: describes the project itself (roadmap, versioning, contributing) and is true today.

Milestones map to versions: M1a = 0.1.0, M1 = 0.2.0, M2 = 0.5.0 first (the cloud agent, D-131), M3 (mainnet beta) = 1.0.0; 0.3.0 is the usable local app and 0.4.0 (released 27 Oct 2026) adds Messages, Files and paid-action confirmation; 0.4.1 (28 Oct 2026) refreshes the look of the local app and moves Approvals into it. See [Status and roadmap](project/status-and-roadmap.md).
