---
'@4thtech-io/submitter': patch
'@4thtech-io/chain': patch
---

Faucet robustness (M1-10b-c). When an earlier `approve` from the faucet wallet is still pending (its `pending` nonce is above its `latest` one), a claim that needs a new approve is refused at once with the retryable `busy` (the HTTP answer stays `unavailable`) and nothing is sent, so a stuck approve can no longer wedge later claims. Every faucet gas limit is capped at `FAUCET_MAX_GAS` (300k): a simulation above it is refused, not clamped, and nothing is sent.
