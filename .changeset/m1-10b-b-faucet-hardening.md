---
'@4thtech-io/submitter': patch
'@4thtech-io/chain': patch
---

Faucet hardening (M1-10b-b). The faucet charges a claim in storage before it sends anything and refunds it if nothing was sent, so a storage failure can no longer allow a second claim. After a lost broadcast answer, a retry returns the earlier transaction instead of `already_claimed`. The `depositFor` gas limit now always comes from a simulation: when an `approve` is needed, the faucet waits for it to be mined first. Each environment pins its own faucet wallet address (`SUBMITTER_FAUCET_ADDRESS_<chainId>`), so staging and production cannot share a faucet key.
