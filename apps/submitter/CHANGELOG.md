# @4thtech-io/submitter

## 0.1.7

### Patch Changes

- @4thtech-io/chain@0.4.5
  - @4thtech-io/crypto@0.4.5

## 0.1.6

### Patch Changes

- Updated dependencies [6d5b6aa]
  - @4thtech-io/crypto@0.4.4
  - @4thtech-io/chain@0.4.4

## 0.1.5

### Patch Changes

- @4thtech-io/chain@0.4.3
  - @4thtech-io/crypto@0.4.3

## 0.1.4

### Patch Changes

- @4thtech-io/chain@0.4.2
  - @4thtech-io/crypto@0.4.2

## 0.1.3

### Patch Changes

- @4thtech-io/chain@0.4.1
  - @4thtech-io/crypto@0.4.1

## 0.1.2

### Patch Changes

- Updated dependencies [662785b]
  - @4thtech-io/crypto@0.4.0
  - @4thtech-io/chain@0.4.0

## 0.1.1

### Patch Changes

- @4thtech-io/chain@0.3.0
  - @4thtech-io/crypto@0.3.0

## 0.1.0

### Minor Changes

- 52fd677: Faucet and gas pool low-balance signal (M1-10b-e). `@4thtech-io/chain`: the faucet wallet adds `balances()` (native coin in wei, fee token in whole US cents; reads only), and `parseHealthResponse` accepts the optional per-chain `gas` (`ok` or `low`) and `faucet` (`ok`, `low` or `paused`) states. `@4thtech-io/submitter`: per-chain low-balance thresholds (`POOL_THRESHOLDS`; Base Sepolia measured, Chiado to verify); `/v1/health` reports `gas` and `faucet` per chain; a faucet that cannot cover one grant refuses claims with the stable code `paused` (HTTP 503) before its wallet is empty, and charges no limit. One grant is now $0.50 (5 proofs) instead of $1 by default; the per-agent, per-IP and daily limits are unchanged.
- e263556: `POST /v1/deposit-authorization` relays a gasless test-USDC top-up (Base Sepolia only) when `SUBMITTER_DEPOSIT_AUTH_CHAINS` enables it; off by default (501 as before). Strict body parse, payee and window checks, every relay check of `@4thtech-io/chain` (amount $5 to $50, signature, unused nonce, simulation, gas cap) before its own gas wallet signs, one request at a time per chain in the new `SubmitterDepositRelay` Durable Object, idempotent on `(chainId, from, nonce)`, 5 top-ups per agent and 20 requests per IP per hour, fixed error codes and no logging.

### Patch Changes

- d70bf37: The submitter's chain port reads a `getRecord` revert as "no such record" only when its data is exactly the `RecordNotFound()` selector; revert data with trailing bytes stays an RPC error. The proof-pack verifier now reports a `RecordNotFound()` revert as `record_not_found` instead of `chain_unavailable`; any other revert is still `chain_unavailable`, and a missing record never verifies. The submitter's Worker entry module exports only the fetch handler and its Durable Object classes, so local `wrangler dev` starts; the package's shared exports move to `lib.ts`.
- 7a67b65: The submitter's chain port now sends its RPC requests with `redirect: "manual"`. The Workers runtime refuses `redirect: "error"` with a TypeError, so every RPC call failed and `/v1/health` reported each chain unavailable. A redirect is still never followed: a 3xx answer moves to the next RPC URL.
- 5261347: The submitter's chain port reads the Notary's `RecordNotFound()` revert from `getRecord` as "no such record", like the read client does. It used to treat that revert as an RPC error, so every new record made the submitter answer 503 `unavailable`. Any other `getRecord` revert is still an error.
- 87f53de: A held item (the Notary paused, or the chain unreadable) now stops retrying 24 hours after the submitter first took it (`SUBMITTER_MAX_HELD_SECONDS`, 300 s to 7 days), or at its own deadline if that comes first. Past that it is `failed` with `unavailable`, so the queue cannot grow without bound. Clients read the chain after any `failed` answer and may post the item again.
- e51e49e: Faucet hardening (M1-10b-b). The faucet charges a claim in storage before it sends anything and refunds it if nothing was sent, so a storage failure can no longer allow a second claim. After a lost broadcast answer, a retry returns the earlier transaction instead of `already_claimed`. The `depositFor` gas limit now always comes from a simulation: when an `approve` is needed, the faucet waits for it to be mined first. Each environment pins its own faucet wallet address (`SUBMITTER_FAUCET_ADDRESS_<chainId>`), so staging and production cannot share a faucet key.
- 113cd50: Faucet robustness (M1-10b-c). When an earlier `approve` from the faucet wallet is still pending (its `pending` nonce is above its `latest` one), a claim that needs a new approve is refused at once with the retryable `busy` (the HTTP answer stays `unavailable`) and nothing is sent, so a stuck approve can no longer wedge later claims. Every faucet gas limit is capped at `FAUCET_MAX_GAS` (300k): a simulation above it is refused, not clamped, and nothing is sent.
- 61dc2c0: The submitter has a Wrangler configuration for its staging (`workers.dev`) and production (`submit.agentlink.4thtech.io`) Workers and deploy smoke tests (health, a simulated notarize per chain, the faucet refusing a mainnet); deployed by CI only (M1-10c). No runtime code changed.
- 320bc9e: Receipts covered by the sender's proof fee (M1-34-b, D-114). The submitter accepts up to 3 receipts for a record the Notary stores (its NOTARIZE fee was charged), whatever the recipient holds: one `getRecord` read per record before simulation; a receipt for an unknown record is `failed` with `RecordNotFound`, a new type over the cap (on-chain plus in flight) with `receipt_limit`, and ACCEPTED against REJECTED in flight with `ConflictingReceipt`. The chain port gains `recordReceipts` and `MAX_RECEIPTS_PER_RECORD`. `createProofSubmitter` never sends a receipt in direct mode unless `directReceipts: true`, so the recipient's own account never pays for it unasked; a receipt no submitter takes is `pending`. `ProofSubmitter.acknowledge` takes an optional per-call `waitMs`. The core posts queued receipts (`postQueuedReceipts`, at most 5 per pass, least recently tried first, 2 s wait each) after each sync pass's new envelopes, the same signed bytes until they land; a receipt the chain refuses for good (`RecordNotFound`, `InvalidSignature`, `NotRecipient`) becomes `receipt_failed` and is not retried.
- 7b053cc: M1-3j-c: Gnosis Chiado (10200) is on the testnet faucet allowlist (`FAUCET_CHAIN_IDS` = 84532, 10200), so it joins automatic selection beside Base Sepolia (07 §6.3, D-40). The submitter serves Chiado and its faucet in staging and production (`SUBMITTER_CHAINS` and `SUBMITTER_FAUCET_CHAINS` = `84532,10200`, a distinct pinned faucet wallet per environment). The faucet credits Chiado's native xDAI with one `depositFor` carrying the amount (D-46).
- e2a5052: The submitter's chain port now reads a record as "absent" only from the Notary's `RecordNotFound()` revert. A returned record with a zero signer is a bad answer, like any other revert, a revert without data, a transport error, a timeout or an empty result, so the submitter answers `unavailable` and never signs a record or refuses a receipt on a failed read (M1-4c-c).
- d48cc3f: M3-4b-t-T2-b: the gasless authorization builder now signs a window of at most 15 minutes (`GASLESS_MAX_WINDOW_SECONDS` = 900, was 3600), the same bound the relay checks (`validBefore` at most now + 900 + 120 s skew). Both relay checks read the one constant. Stale "until M1-3c" comments updated; a registry-level test covers the `GASLESS_TOPUP_ENABLED` kill switch.
- dce6849: `POST /v1/deposit-authorization` hardening (still off by default): refuses `unavailable` and sends nothing while more than 3 relay transactions are pending (counter `deposit_relay_stuck`); a global hourly cap `SUBMITTER_DEPOSIT_AUTH_REQUESTS_PER_HOUR` (default 200); a failed send gives the agent's hourly count back; each authorization is recorded before it is sent, so a crash mid-send never resends it; `bad_request` and `too_large` now answer `{status: "failed", error}` like every other refusal of the route.
- Updated dependencies [d70bf37]
- Updated dependencies [7a67b65]
- Updated dependencies [5261347]
- Updated dependencies [e51e49e]
- Updated dependencies [113cd50]
- Updated dependencies [b155084]
- Updated dependencies [52fd677]
- Updated dependencies [cb4a63a]
- Updated dependencies [320bc9e]
- Updated dependencies [5864ac4]
- Updated dependencies [7b053cc]
- Updated dependencies [3a3837b]
- Updated dependencies [e2a5052]
- Updated dependencies [9676c15]
- Updated dependencies [5c19ee0]
- Updated dependencies [1cd25e4]
- Updated dependencies [0ece43e]
- Updated dependencies [c6aa21f]
- Updated dependencies [62e8d42]
- Updated dependencies [9dbaa44]
- Updated dependencies [5ffb078]
- Updated dependencies [d48cc3f]
  - @4thtech-io/chain@0.2.0
  - @4thtech-io/crypto@0.2.0

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
