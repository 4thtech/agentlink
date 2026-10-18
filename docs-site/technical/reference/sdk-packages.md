# SDK packages

> **Status: Mixed.** The Talk libraries (`@4thtech-io/types`, `crypto`, `transport-nostr`, `core`, `node`) are bundled into the released `@4thtech-io/agentlink` CLI (v0.1.1); they are private workspace packages and are not published to npm on their own. Chain and storage packages are planned for v0.2.0 (M1). APIs may change before 1.0.0. Source: [07 §1–§2](https://github.com/4thtech/agentlink/blob/main/docs/foundation/07-sdk-transport-storage.md).

All shared packages run in Node (LTS), modern browsers and Cloudflare Workers unless marked otherwise. During the beta, all public packages share one product version.

## Planned package map

| Package | Exposes | Planned for |
|---|---|---|
| `@4thtech-io/types` | Shared types, zod schemas, constants | v0.1.0 |
| `@4thtech-io/crypto` | Key derivation, HPKE, AES-GCM, STREAM file encryption, hashing, JCS, BIP-340, EIP-712 helpers | v0.1.0 (file and proof parts v0.2.0) |
| `@4thtech-io/transport-nostr` | `Transport` implementation: relay pool, gift wrap, subscriptions, sync | v0.1.0 |
| `@4thtech-io/core` | `AgentLinkClient`: identity, contacts, envelopes, threads, files, proofs, policies, approvals; `KeyStore`, `Store`, `ApprovalChannel` interfaces | v0.1.0 (files and proofs v0.2.0) |
| `@4thtech-io/node` | Node implementations: keychain `KeyStore`, SQLite `Store`, local approval server (Node only) | v0.1.0 |
| `@4thtech-io/storage` | `StorageAdapter`: inline, encrypted drop, S3-compatible; consumer connectors later | v0.2.0 (connectors v0.3.0) |
| `@4thtech-io/chain` | Chain configs, contract bindings, fee quotes, credits, submitter client, proof verification | v0.2.0 |
| `@4thtech-io/occ-v2-abi` | Contract ABIs (full and client-safe) and testnet addresses, imported from a tagged contracts release and verified against its SHA-256 manifest; private, bundled into the CLI, never published on its own (D-83). See [Contracts](contracts.md#interface-package) | In the repository (Base Sepolia testnet); used by the CLI from v0.2.0 |
| `@4thtech-io/agentlink` | CLI and MCP server (stdio; Node only) | v0.1.0 |

The `@4thtech-io` scope is the internal workspace scope; only `@4thtech-io/agentlink` is on npm today. See [Design decisions](../concepts/design-decisions.md). Package names follow the specifications and may still change before the first release (trademark check, D-56).

Integrators use `@4thtech-io/core` with their own `KeyStore` and `Store` and pass their `appId` to earn integrator fees.

## Outline (filled in at release)

- Per package: install, entry points, main types and functions, runtime support, examples
- Generated API reference (tooling decided at M1a)
- Compatibility of formats across versions

**Filled in at:** M1a (v0.1.0) and M1 (v0.2.0); backlog cards DOCS-M1a and DOCS-M1b.
