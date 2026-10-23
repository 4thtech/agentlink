---
'@4thtech-io/submitter': minor
---

`POST /v1/deposit-authorization` relays a gasless test-USDC top-up (Base Sepolia only) when `SUBMITTER_DEPOSIT_AUTH_CHAINS` enables it; off by default (501 as before). Strict body parse, payee and window checks, every relay check of `@4thtech-io/chain` (amount $5 to $50, signature, unused nonce, simulation, gas cap) before its own gas wallet signs, one request at a time per chain in the new `SubmitterDepositRelay` Durable Object, idempotent on `(chainId, from, nonce)`, 5 top-ups per agent and 20 requests per IP per hour, fixed error codes and no logging.
