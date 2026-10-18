---
'@4thtech-io/occ-v2-abi': patch
'@4thtech-io/chain': patch
---

M1-3f: new private package `@4thtech-io/occ-v2-abi` with the OCC v2 contract ABIs and the Base Sepolia testnet addresses from contracts release `v0.1.0-testnet.2`, verified against its SHA-256 manifest and bundled into the CLI, never published (D-83). It exports client-safe Notary and vault ABIs without admin, upgrade or module functions. `@4thtech-io/chain` pins that release (`OCC_V2_ABI_PIN`).
