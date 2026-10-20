# @4thtech-io/submitter

## 0.0.1

### Patch Changes

- 4bce1b3: The submitter queue's alarm interval can be set through an optional `pollMs` in its deps, used only by the Miniflare tests so the alarm runs when a test runs it; production keeps the 2 s interval.
- 8c9cdd1: M1-10a-b: the submitter's chain port adds `latestNonce()` (mined transactions only). The submitter resubmits a shared revert with no identifiable cause split per signer, reconciles a given-up transaction against the `latest` nonce so no nonce is skipped, and keeps an item in flight when the chain cannot be read while re-simulating it after a revert.
- 1753640: M1-10a: the submitter. `@4thtech-io/chain` adds the submitter wire format (`parseSubmitRequest`, `parseSubmitResponse`, `parseStatusResponse`, `parseHealthResponse`), the local EOA signature check (`itemSignatureMatches`), the Worker's chain port (`createSubmitterChain`: per-item and batch simulation, the gas-key wallet, inclusion from the receipt's Notary events) and the client with failover (`createSubmitterClient`). `@4thtech-io/submitter` is the Worker: `/v1/notarize`, `/v1/receipt`, `/v1/status/:txHash`, `/v1/health`, and `/v1/deposit-authorization` disabled; G-4 batching, FA-1 code-bearing signers solo and gas limit = simulated gas + margin, FA-3 items already on-chain skipped and not sent, per-IP and per-signer limits, per-chain nonce serialisation in a Durable Object, items held while the Notary is paused.
- 75737c8: M1-10b: the testnet credits faucet. `@4thtech-io/chain` adds the hard-coded faucet chain allowlist (`FAUCET_CHAIN_IDS`, `isFaucetChain`: Base Sepolia until Chiado is deployed), `buildDepositFor` (an exact `approve`, then `depositFor(agent, token, amount)`) and the faucet wallet (`createFaucetChain`), which refuses any chain off the allowlist and sends nothing until the chain ID, balances and simulation pass. `@4thtech-io/submitter` adds `POST /v1/faucet` with one claim per agent per window, claims per IP per day, a global daily cap per chain, a per-IP request limit, and a Durable Object per chain that serialises claims so the caps hold under concurrency.
- Updated dependencies [8c9cdd1]
- Updated dependencies [1753640]
- Updated dependencies [75737c8]
- Updated dependencies [dd9650b]
- Updated dependencies [4d7d3e4]
- Updated dependencies [6c759e0]
- Updated dependencies [2b11a8d]
- Updated dependencies [85b6c1d]
- Updated dependencies [bc3bfe4]
- Updated dependencies [5a9ee7d]
- Updated dependencies [248b9af]
- Updated dependencies [92871c9]
- Updated dependencies [3c350b7]
- Updated dependencies [50340cb]
- Updated dependencies [2e6b70e]
- Updated dependencies [c5b21ee]
  - @4thtech-io/chain@0.1.2
  - @4thtech-io/crypto@0.1.2
