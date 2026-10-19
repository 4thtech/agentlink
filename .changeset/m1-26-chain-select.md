---
'@4thtech-io/chain': patch
---

M1-26: zero-config chain selection (07 §6.3, D-40). `detectFunding` reads, in parallel and within a short per-chain budget, the fee quote, `creditsOf` and (only where a gasless top-up exists) the stablecoin balance on every selectable chain; a chain that fails or is late is listed as unavailable. `pickChain` picks the default chain if funded, otherwise the cheapest funded chain, otherwise returns `needs_credits` with a top-up route (chain, token, USD amount, agent address) to the cheapest chain. Tie-breaks are by fee, then credits before a top-up, then the lower chain ID. Mainnet entries (flag or known chain ID) are never queried, picked or offered. `selectPayingChain` combines both; `createChainSelector` adds a 60 s detection cache.
