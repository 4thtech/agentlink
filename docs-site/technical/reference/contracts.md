# Contracts

> **Status: Design.** The contracts are deployed on the Base Sepolia testnet and passed a live smoke test (pre-audit); no released AgentLink version uses them yet. Gnosis Chiado is planned next, at the same addresses, with released testnet support planned for v0.2.0 (M1); mainnet (Base, Gnosis) for v1.0.0 (M3), after the external audit. The Base Sepolia addresses below are for development and testing only. Source: [05 OCC v2 contracts](https://github.com/4thtech/agentlink/blob/main/docs/foundation/05-contracts-occ-v2.md).

The contract source lives in a separate private repository during the beta. Verified source is planned to be published at mainnet (licence proposed: BUSL-1.1, to be confirmed). This repository consumes only the exported ABI JSON, through the private in-repo package `@4thtech-io/occ-v2-abi` (see [Interface package](#interface-package)), and the shared test vectors.

## Contracts

| Contract | Purpose | Planned for |
|---|---|---|
| `OCCFeeVault` | Non-custodial credits (deposit, `depositFor`, EIP-3009 deposits (not enabled yet; see below), withdraw any time), fee configuration within on-chain caps, quotes, charging, treasury sweeps, integrator apps and payouts | M1 (testnets), M3 (mainnet) |
| `OCCNotary` | Signature-based records and receipts; anyone can submit | M1 (testnets), M3 (mainnet) |
| `OCCRegistry` | Verified agent cards (agent and owner binding) and revocation | M2 |
| `OCCAnchor` | Batched Merkle roots | M4 |
| `OCCDeals` | Deal state machine | M5 |

## Key interfaces (design)

```solidity
// OCCNotary
function notarize(Record calldata r, bytes calldata sig) external returns (bytes32 recordId);
function notarizeDirect(Record calldata r) external payable returns (bytes32 recordId);
function acknowledge(Receipt calldata rc, bytes calldata sig) external;
function getRecord(bytes32 recordId) external view returns (RecordState memory);

// OCCFeeVault (credits)
function depositFor(address payer, address token, uint256 amount) external payable;
function withdraw(address token, uint256 amount, address to) external;
function creditsOf(address payer, address token) external view returns (uint256);
```

## Guarantees by design

- No admin function can move, freeze or reduce a payer's credits; pausing blocks new charges, never withdrawals.
- Fees are bounded by on-chain caps; raising a cap has a 7-day delay; every record carries the signer's maximum fee.
- Governance by Safe multisigs through `AccessManager` with per-function delays; the Notary can be frozen against upgrades.
- Identical addresses on every chain where the contracts are deployed (CREATE3 via CreateX). Testnets and mainnets use separate deployer keys, so mainnet addresses differ from testnet addresses (owner decision D-71). Clients use only the addresses listed for each chain ID; the per-chain list is the source of truth.

## Interface package

`@4thtech-io/occ-v2-abi` (in `packages/occ-v2-abi`) is how this repository gets the contract interface. It is a private workspace package: bundled into the CLI and never published to npm on its own (D-83).

- **Where it comes from.** Each tagged release of the private contracts repository exports the interface ABIs (`IOCCNotary`, `IOCCFeeVault`, `IOCCManaged`, `IOCCErrors`, plus the OpenZeppelin errors and events the deployed contracts can raise), one address file per chain and a `manifest.json` with the SHA-256 of every file. The ABIs are generated from the Solidity interfaces, not the concrete contracts. No Solidity source is exported, and CI fails if a `.sol` file or a Solidity pragma appears anywhere in this repository.
- **How it is imported.** `node tools/occ-v2-abi/import.mjs --tag <tag> --manifest-sha256 <hash>` downloads the release assets, checks `manifest.json` against the hash printed in the release notes, checks that the tag's commit is the manifest's `sourceCommit`, checks every file against the manifest, and vendors the exact bytes under `artifacts/<tag>/`. `release.json` pins the repository, tag, commit and manifest hash. The TypeScript in `src/generated/` adds only `as const` (so viem infers types) and is regenerated, never edited.
- **What CI checks.** On every pull request: the manifest hash equals the pin, every vendored file equals its manifest entry, no file is unlisted, only the pinned release is vendored, the generated TypeScript equals the JSON, and the only address file is Base Sepolia (84532), marked as a testnet. `@4thtech-io/chain` pins the same tag and manifest hash, pins the function selectors, event topics and error selectors of every ABI, and checks that the `Record` and `Receipt` structs the Notary takes match the EIP-712 types in `@4thtech-io/crypto`. The EIP-712 types are defined only there; the package does not repeat them.
- **Client-safe subset.** The interfaces include governance, upgrade and module-only functions (all gated on chain). The package tags every function (`client`, `integrator`, `maintenance`, `admin`, `upgrade`, `module`, `pending`) and exports `occNotaryClientAbi` and `occFeeVaultClientAbi`, which hold only the `client` functions plus every event and error, for decoding. Client code binds to these; the full ABIs are for decoding and review. A function added in a new release is a type error until it is tagged.
- **EIP-3009 deposits.** `depositWithAuthorization` is in the interface, but the deployed vault refuses it until a later contracts release. The address file says `depositWithAuthorization: false` and marks USDC `eip3009: false`, and the function is tagged `pending`, so it is not in the client ABI. Clients use `deposit` or `depositFor`.

Current import: `v0.1.0-testnet.2` of the contracts repository (commit `d46545b`), manifest SHA-256 `b1a8daa57d51bcbfbecbc91e6c5d2740d76428a4f63bbd5f1043537591188c1b`.

## Addresses

**Testnet only, in development.** These are the pre-audit Base Sepolia deployment (14 Oct 2026), for development and testing; they hold no real value and may be redeployed. The source of truth is `addresses/84532.json` in `@4thtech-io/occ-v2-abi`; there is no mainnet entry, and CI refuses one.

| Chain | Chain ID | Contract | Address |
|---|---|---|---|
| Base Sepolia | 84532 | `OCCNotary` (proxy) | `0xB29dEdEe26D480105DAD5b90f549a09d376d855F` |
| Base Sepolia | 84532 | `OCCFeeVault` (proxy) | `0x91A40104553Bd1731c3fBe05209A908B40e50f8d` |
| Base Sepolia | 84532 | `AccessManager` | `0x7B05B6C56E4f073df60da9Fa640b1f7ffCD9D3A2` |

Fee token on Base Sepolia: test USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (6 decimals; EIP-3009 deposits not enabled yet). Gnosis Chiado follows at the same addresses (M1-3j). Mainnet addresses differ from testnet addresses (D-71) and are published at M3.

## Outline (filled in at deployment)

- Full ABI reference and events
- Addresses for further chains (Gnosis Chiado at M1, mainnets at M3)
- Roles, delays and governance
- Audit reports (after fixes)

**Filled in at:** M1 (testnets) and M3 (mainnet); backlog cards DOCS-M1b and DOCS-M3.
