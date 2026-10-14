# Contracts

> **Status: Design.** Not deployed. Testnet deployment is planned for v0.2.0 (M1), on Base Sepolia first and Gnosis Chiado later at the same addresses; mainnet (Base, Gnosis) for v1.0.0 (M3). No addresses exist yet. Source: [05 OCC v2 contracts](https://github.com/4thtech/agentlink/blob/main/docs/foundation/05-contracts-occ-v2.md).

The contract source lives in a separate private repository during the beta. Verified source is planned to be published at mainnet (licence proposed: BUSL-1.1, to be confirmed). This repository consumes only the ABI package `@agentlink/occ-v2-abi` and shared test vectors.

## Contracts

| Contract | Purpose | Planned for |
|---|---|---|
| `OCCFeeVault` | Non-custodial credits (deposit, `depositFor`, EIP-3009 deposits, withdraw any time), fee configuration within on-chain caps, quotes, charging, treasury sweeps, integrator apps and payouts | M1 (testnets), M3 (mainnet) |
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
- Identical addresses on every chain where the contracts are deployed (CREATE3 via CreateX): one set for mainnets and a different set for testnets. Clients use only the addresses listed for each chain ID.

## Addresses

None yet. Addresses and the verified per-chain configuration are published here and in `@agentlink/occ-v2-abi` at each deployment.

## Outline (filled in at deployment)

- Full ABI reference and events
- Addresses per chain (testnets at M1, mainnets at M3)
- Roles, delays and governance
- Audit reports (after fixes)

**Filled in at:** M1 (testnets) and M3 (mainnet); backlog cards DOCS-M1b and DOCS-M3.
