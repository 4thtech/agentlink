---
'@4thtech-io/chain': patch
'@4thtech-io/submitter': patch
'@4thtech-io/agentlink': patch
---

M1-3j-c: Gnosis Chiado (10200) is on the testnet faucet allowlist (`FAUCET_CHAIN_IDS` = 84532, 10200), so it joins automatic selection beside Base Sepolia (07 §6.3, D-40). The submitter serves Chiado and its faucet in staging and production (`SUBMITTER_CHAINS` and `SUBMITTER_FAUCET_CHAINS` = `84532,10200`, a distinct pinned faucet wallet per environment). The faucet credits Chiado's native xDAI with one `depositFor` carrying the amount (D-46).
