# Networks and contract addresses

> **Status: testnet only, pre-audit.** One network is live today: Base Sepolia. Gnosis Chiado is planned. There are no mainnet deployments. Nothing here holds real value, and testnet deployments may be redeployed. No released AgentLink version records proof yet (planned for v0.2.0, M1).

This page lists every network the OCC v2 contracts are deployed on, or planned for, with the contract addresses and a way to check on a public block explorer that they are in use. For what the contracts do, see [Contracts](contracts.md).

**Where the addresses come from.** The deployed addresses come from the contracts release carried by the private package `@4thtech-io/occ-v2-abi` (`getDeployment(chainId)`), which is checked against the release manifest. A test in `tools/networks-page.test.mjs` fails CI when an address on this page differs from the package, or when the package has an address this page lacks. Only addresses the package exposes are listed; the implementation contracts behind the proxies are not part of it, so they are not listed here.

## All networks

| Network | Chain ID | Status | Deployed | Explorer |
|---|---|---|---|---|
| Base Sepolia (testnet) | 84532 | Live (pre-audit) | 2026-10-14, block 48120712, campaign-1 | [sepolia.basescan.org](https://sepolia.basescan.org) |
| Gnosis Chiado (testnet) | 10200 | Planned: deploying soon, at the same addresses as Base Sepolia | Not yet | [gnosis-chiado.blockscout.com](https://gnosis-chiado.blockscout.com) |
| Base (mainnet) | 8453 | Not deployed (planned for v1.0.0, M3, after the external audit) | Not yet | Not applicable |
| Gnosis (mainnet) | 100 | Not deployed (planned for v1.0.0, M3, after the external audit) | Not yet | Not applicable |

Mainnet addresses will differ from testnet addresses (D-71) and are published at M3.

## Base Sepolia (84532)

| Contract | Address | Verified activity |
|---|---|---|
| `OCCNotary` (proxy) | [0xB29dEdEe26D480105DAD5b90f549a09d376d855F](https://sepolia.basescan.org/address/0xB29dEdEe26D480105DAD5b90f549a09d376d855F) | [Transactions](https://sepolia.basescan.org/address/0xB29dEdEe26D480105DAD5b90f549a09d376d855F) |
| `OCCFeeVault` (proxy) | [0x91A40104553Bd1731c3fBe05209A908B40e50f8d](https://sepolia.basescan.org/address/0x91A40104553Bd1731c3fBe05209A908B40e50f8d) | [Transactions](https://sepolia.basescan.org/address/0x91A40104553Bd1731c3fBe05209A908B40e50f8d) |
| `AccessManager` | [0x7B05B6C56E4f073df60da9Fa640b1f7ffCD9D3A2](https://sepolia.basescan.org/address/0x7B05B6C56E4f073df60da9Fa640b1f7ffCD9D3A2) | [Transactions](https://sepolia.basescan.org/address/0x7B05B6C56E4f073df60da9Fa640b1f7ffCD9D3A2) |
| Fee token: test USDC (6 decimals; EIP-3009 deposits not enabled) | [0x036CbD53842c5426634e7929541eC2318f3dCF7e](https://sepolia.basescan.org/address/0x036CbD53842c5426634e7929541eC2318f3dCF7e) | [Transactions](https://sepolia.basescan.org/address/0x036CbD53842c5426634e7929541eC2318f3dCF7e) |

**About "Verified activity".** The deployment passed a live smoke test on 14 Oct 2026. The individual transaction hashes of that run are not recorded in this repository, so no single transaction is linked. Open the **Transactions** page of any contract above to see every call it has received, and the **Events** tab of the notary and vault proxies for the matching events. This page will link individual example transactions once they are recorded in a public release note.

## Gnosis Chiado (10200)

Planned. The contracts are not deployed on Chiado yet, so there are no addresses to check. The plan is the same addresses as Base Sepolia (the contracts use CREATE3 through CreateX, so the same deployer gives the same address on every chain). This page will list them here, with explorer links, only after the deployment has happened and been checked.

## Mainnets

Not deployed. Mainnet deployment (Base and Gnosis) is planned for v1.0.0 (M3), after the external audit. CI refuses a mainnet entry in the address package until then.
