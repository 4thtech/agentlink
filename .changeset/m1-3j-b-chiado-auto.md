---
'@4thtech-io/chain': patch
'@4thtech-io/agentlink': patch
---

M1-3j-b: automatic selection (`autoSelectableChains()`, the default proof networks) now uses exactly the registry chains the testnet faucet serves (07 §6.3, D-40), so an unfunded payer is never routed to a chain where it cannot get credits. Gnosis Chiado (10200) joins automatically once the faucet allowlist names it; in this release that is still Base Sepolia only, so routing is unchanged.
