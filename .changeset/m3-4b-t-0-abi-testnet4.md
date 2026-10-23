---
'@4thtech-io/occ-v2-abi': patch
'@4thtech-io/chain': patch
---

M3-4b-t-0: the private `@4thtech-io/occ-v2-abi` package now carries contracts release `v0.1.0-testnet.4`: Base Sepolia's vault accepts `depositWithAuthorization` (capability true, USDC `eip3009` true; Gnosis Chiado stays false) and the ABIs add the `DepositMismatch()` error. `depositWithAuthorization` is re-tagged `relay` and exported only in the new submitter-side `occFeeVaultRelayAbi`; the client ABI still excludes it. `@4thtech-io/chain` pins the new release (`OCC_V2_ABI_PIN`) and adds the `GASLESS_TOPUP_ENABLED = false` kill switch in the chain registry, so no fee token is composed `eip3009` until M3-4b-t-4.
