---
'@4thtech-io/submitter': minor
'@4thtech-io/chain': minor
---

Faucet and gas pool low-balance signal (M1-10b-e). `@4thtech-io/chain`: the faucet wallet adds `balances()` (native coin in wei, fee token in whole US cents; reads only), and `parseHealthResponse` accepts the optional per-chain `gas` (`ok` or `low`) and `faucet` (`ok`, `low` or `paused`) states. `@4thtech-io/submitter`: per-chain low-balance thresholds (`POOL_THRESHOLDS`; Base Sepolia measured, Chiado to verify); `/v1/health` reports `gas` and `faucet` per chain; a faucet that cannot cover one grant refuses claims with the stable code `paused` (HTTP 503) before its wallet is empty, and charges no limit. One grant is now $0.50 (5 proofs) instead of $1 by default; the per-agent, per-IP and daily limits are unchanged.
