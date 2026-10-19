---
'@4thtech-io/occ-v2-abi': patch
'@4thtech-io/chain': patch
---

M1-3j: the private `@4thtech-io/occ-v2-abi` package now carries contracts release `v0.1.0-testnet.3`: the same ABIs plus the Gnosis Chiado (10200) addresses, deployed on 2026-10-19 with the Base Sepolia addresses. `@4thtech-io/chain` pins the new release (`OCC_V2_ABI_PIN`) and its registry now lists Chiado with its native fee asset. New `autoSelectableChains()` keeps Chiado out of automatic selection (M1-3j-b); only an explicit chain override may name it.
