---
'@4thtech-io/chain': patch
'@4thtech-io/submitter': patch
---

M1-10a: the submitter. `@4thtech-io/chain` adds the submitter wire format (`parseSubmitRequest`, `parseSubmitResponse`, `parseStatusResponse`, `parseHealthResponse`), the local EOA signature check (`itemSignatureMatches`), the Worker's chain port (`createSubmitterChain`: per-item and batch simulation, the gas-key wallet, inclusion from the receipt's Notary events) and the client with failover (`createSubmitterClient`). `@4thtech-io/submitter` is the Worker: `/v1/notarize`, `/v1/receipt`, `/v1/status/:txHash`, `/v1/health`, and `/v1/deposit-authorization` disabled; G-4 batching, FA-1 code-bearing signers solo and gas limit = simulated gas + margin, FA-3 items already on-chain skipped and not sent, per-IP and per-signer limits, per-chain nonce serialisation in a Durable Object, items held while the Notary is paused.
