# @4thtech-io/occ-v2-abi

## 0.0.1

### Patch Changes

- 2b11a8d: M1-3f: new private package `@4thtech-io/occ-v2-abi` with the OCC v2 contract ABIs and the Base Sepolia testnet addresses from contracts release `v0.1.0-testnet.2`, verified against its SHA-256 manifest and bundled into the CLI, never published (D-83). It exports client-safe Notary and vault ABIs without admin, upgrade or module functions. `@4thtech-io/chain` pins that release (`OCC_V2_ABI_PIN`) and loads its contracts with EIP-55 checksummed addresses (`loadOccV2Contracts`, viem `getAddress`).
- 85b6c1d: M1-3j: the private `@4thtech-io/occ-v2-abi` package now carries contracts release `v0.1.0-testnet.3`: the same ABIs plus the Gnosis Chiado (10200) addresses, deployed on 2026-10-19 with the Base Sepolia addresses. `@4thtech-io/chain` pins the new release (`OCC_V2_ABI_PIN`) and its registry now lists Chiado with its native fee asset. New `autoSelectableChains()` keeps Chiado out of automatic selection (M1-3j-b); only an explicit chain override may name it.
