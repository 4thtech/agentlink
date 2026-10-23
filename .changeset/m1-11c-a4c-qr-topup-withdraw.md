---
'@4thtech-io/types': minor
'@4thtech-io/core': minor
'@4thtech-io/node': minor
'@4thtech-io/agentlink': minor
---

Add credits by QR on the Gnosis test network, and Withdraw credits, in the local UI (M1-11c-a4c, D-122, D-123). New owner actions `credits.deposit` and `credits.withdraw` (strict params, 600 s lifetime). Core adds `proofs.topUp()`, `proofs.addReceivedFunds(signed)` and `proofs.withdrawCredits(signed)`: the agent's own `deposit` or `withdraw` in direct mode, signed by its KeyStore, only after a fresh owner-signed action, keeping a 0.01 xDAI gas reserve, Chiado only, never a mainnet; a withdrawal goes to the agent's own account only. The local UI server adds `GET /api/ui/proofs/top-up` and the presence-gated `POST /api/ui/proofs/top-up` and `POST /api/ui/proofs/withdraw`. The CLI wires direct mode per testnet.
