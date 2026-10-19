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

## Chain client (`@4thtech-io/chain`)

**In development (M1-4a, M1-4b, M1-26); not user-facing yet.** It builds on the contract interface package ([Contracts](contracts.md#interface-package)). Nothing here asks the user for a chain, a wallet or gas: chains are picked automatically.

- **Supported chains.** The client knows a chain only when it ships a network entry for it and the pinned contracts release has a deployment there: Base Sepolia today. The two must agree on the chain and the fee tokens, or the client refuses that chain. Nothing is fetched at runtime.
- **RPC endpoints.** Several public endpoints per chain; users can add up to 5 of their own, which are tried first. An endpoint must be `https://` with a public host name (no IP address, no `localhost` or local name) and no user info, query or fragment. An owner's own endpoint may carry its provider key in the path, so endpoint addresses are treated as secrets and never logged or returned; errors carry fixed codes only, and no property of the client object (its transport included, or a client made with `extend`) holds an endpoint address. In Node, private and loopback addresses are refused at resolve time and each request connects to the checked address. Each request has a timeout and a few retries before the next endpoint; requests never follow redirects, and only read methods are sent.
- **Address-checked fetch only.** A read client is built only over the platform's address-checked fetch (`nodeRpcFetch` in Node); the product path refuses a plain `fetch`, so a wiring mistake cannot skip the resolve-time address check. This guards against mistakes, not against a malicious caller in the same process.
- **Calls.** The client encodes calls only from the client-safe ABIs; it cannot even form an admin, upgrade or module call, and EIP-3009 deposits stay off until the contracts enable them.
- **Records and receipts.** The builders produce exactly the EIP-712 digests of the shared test vectors. Every Record gets a fresh random nonce and, when it has a recipient, a fresh random 32-byte salt that the caller cannot choose. The record ID is computed as the Notary does: `keccak256(abi.encode(chainId, notary, signer, nonce))`. Signing goes only through the agent's key store.
- **Fees in USD.** A quote is the fee vault's own (`quote`), with the protocol and app parts shown separately in USD. Every launch fee token is a USD stablecoin counted 1:1, so no price service is involved. A token outside the stablecoin allowlist is never priced, shown or deposited, and a quote whose parts do not add up is refused.
- **Credits.** The client reads the agent's prepaid credits for every fee token on every supported chain in parallel; a chain that does not answer is listed as unavailable. Which chain pays is chosen automatically (M1-26): the default chain when its credits cover the fee, otherwise the cheapest chain whose credits do, otherwise a "credits needed" result that names where adding credits costs least, with the agent address and the amount in USD. A chain that does not answer in time is skipped, never chosen; ties go to the lower chain ID, so the choice is stable. Only testnets are ever queried or chosen in this release. An override exists only for Advanced settings.
- **Top-up helper.** For a direct top-up the client prepares the calls (an approval of exactly the amount, then the deposit; one call for xDAI on Gnosis). It sends nothing yet (M1-4c).
- **Credit history.** Only events from the configured fee vault count, and empty (zero-amount) deposits, sweeps and withdrawals are ignored.

## Outline (filled in at release)

- Per package: install, entry points, main types and functions, runtime support, examples
- Generated API reference (tooling decided at M1a)
- Compatibility of formats across versions

**Filled in at:** M1a (v0.1.0) and M1 (v0.2.0); backlog cards DOCS-M1a and DOCS-M1b.
