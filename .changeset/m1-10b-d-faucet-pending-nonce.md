---
'@4thtech-io/chain': patch
---

Faucet: a claim that needs a new `approve` while the faucet wallet's previous transaction is still pending now waits for it (polling the `latest` nonce, within the same `receiptTimeoutMs` budget as the approve's receipt wait) and refuses with `busy` only if it is still pending at the deadline (M1-10b-d). Two claims within about one block no longer get a retryable `unavailable`.
