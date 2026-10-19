---
'@4thtech-io/chain': patch
'@4thtech-io/submitter': patch
---

M1-10b: the testnet credits faucet. `@4thtech-io/chain` adds the hard-coded faucet chain allowlist (`FAUCET_CHAIN_IDS`, `isFaucetChain`: Base Sepolia until Chiado is deployed), `buildDepositFor` (an exact `approve`, then `depositFor(agent, token, amount)`) and the faucet wallet (`createFaucetChain`), which refuses any chain off the allowlist and sends nothing until the chain ID, balances and simulation pass. `@4thtech-io/submitter` adds `POST /v1/faucet` with one claim per agent per window, claims per IP per day, a global daily cap per chain, a per-IP request limit, and a Durable Object per chain that serialises claims so the caps hold under concurrency.
