---
'@4thtech-io/chain': minor
---

Gasless top-up helpers (testnet, Base Sepolia only): `buildReceiveWithAuthorization` signs an EIP-3009 `ReceiveWithAuthorization` with the agent key only (the signature must recover the agent), payee = the shipped fee vault (never a parameter), $5 to $50 and at least the vault `minDeposit`, a 15-minute window and a CSPRNG nonce, under the token domain read from chain and checked by `verifyTokenDomain`. New `POST /v1/deposit-authorization` wire parsers and `createDepositAuthClient` with failover, and the submitter relay side `createDepositRelayChain` (`check` runs every rule, including signature, EOA, unused nonce and simulation, before the gas key signs; `send`), bound to a relay ABI passed in and checked by `checkRelayAbi`. Off until the vault capability lands (M3-4b-t-0).
