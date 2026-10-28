# @4thtech-io/chain

## 0.4.2

### Patch Changes

- @4thtech-io/crypto@0.4.2
  - @4thtech-io/types@0.4.2

## 0.4.1

### Patch Changes

- @4thtech-io/crypto@0.4.1
  - @4thtech-io/types@0.4.1

## 0.4.0

### Patch Changes

- Updated dependencies [662785b]
  - @4thtech-io/crypto@0.4.0
  - @4thtech-io/types@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [b3b8782]
  - @4thtech-io/types@0.3.0
  - @4thtech-io/crypto@0.3.0

## 0.2.0

### Minor Changes

- 52fd677: Faucet and gas pool low-balance signal (M1-10b-e). `@4thtech-io/chain`: the faucet wallet adds `balances()` (native coin in wei, fee token in whole US cents; reads only), and `parseHealthResponse` accepts the optional per-chain `gas` (`ok` or `low`) and `faucet` (`ok`, `low` or `paused`) states. `@4thtech-io/submitter`: per-chain low-balance thresholds (`POOL_THRESHOLDS`; Base Sepolia measured, Chiado to verify); `/v1/health` reports `gas` and `faucet` per chain; a faucet that cannot cover one grant refuses claims with the stable code `paused` (HTTP 503) before its wallet is empty, and charges no limit. One grant is now $0.50 (5 proofs) instead of $1 by default; the per-agent, per-IP and daily limits are unchanged.
- 3a3837b: `KeyStore.signTransaction` signs one direct-mode transaction with the agent's EVM key, on the launch testnets only: EIP-1559, to the AgentLink Notary, fee vault or an offered fee token, with a direct-mode call (`notarizeDirect`, `notarizeBatch`, `acknowledge`, `acknowledgeBatch`, `deposit`, `withdraw` to the agent's own address, `approve` of the vault), bounded value, calldata, gas and fees. Everything else is refused with `transaction_refused` before any key is read. The keychain KeyStore implements it. `@4thtech-io/chain` adds `keyStoreDirectSigner`, `createDirectMode` (testnets of the KeyStore allowlist only), the typed `buildWithdraw` and `sendWithdraw`, and the ChainError code `signing_refused`.
- 5ffb078: Gasless top-up helpers (testnet, Base Sepolia only): `buildReceiveWithAuthorization` signs an EIP-3009 `ReceiveWithAuthorization` with the agent key only (the signature must recover the agent), payee = the shipped fee vault (never a parameter), $5 to $50 and at least the vault `minDeposit`, a 15-minute window and a CSPRNG nonce, under the token domain read from chain and checked by `verifyTokenDomain`. New `POST /v1/deposit-authorization` wire parsers and `createDepositAuthClient` with failover, and the submitter relay side `createDepositRelayChain` (`check` runs every rule, including signature, EOA, unused nonce and simulation, before the gas key signs; `send`), bound to a relay ABI passed in and checked by `checkRelayAbi`. Off until the vault capability lands (M3-4b-t-0).

### Patch Changes

- d70bf37: The submitter's chain port reads a `getRecord` revert as "no such record" only when its data is exactly the `RecordNotFound()` selector; revert data with trailing bytes stays an RPC error. The proof-pack verifier now reports a `RecordNotFound()` revert as `record_not_found` instead of `chain_unavailable`; any other revert is still `chain_unavailable`, and a missing record never verifies. The submitter's Worker entry module exports only the fetch handler and its Durable Object classes, so local `wrangler dev` starts; the package's shared exports move to `lib.ts`.
- 7a67b65: The submitter's chain port now sends its RPC requests with `redirect: "manual"`. The Workers runtime refuses `redirect: "error"` with a TypeError, so every RPC call failed and `/v1/health` reported each chain unavailable. A redirect is still never followed: a 3xx answer moves to the next RPC URL.
- 5261347: The submitter's chain port reads the Notary's `RecordNotFound()` revert from `getRecord` as "no such record", like the read client does. It used to treat that revert as an RPC error, so every new record made the submitter answer 503 `unavailable`. Any other `getRecord` revert is still an error.
- e51e49e: Faucet hardening (M1-10b-b). The faucet charges a claim in storage before it sends anything and refunds it if nothing was sent, so a storage failure can no longer allow a second claim. After a lost broadcast answer, a retry returns the earlier transaction instead of `already_claimed`. The `depositFor` gas limit now always comes from a simulation: when an `approve` is needed, the faucet waits for it to be mined first. Each environment pins its own faucet wallet address (`SUBMITTER_FAUCET_ADDRESS_<chainId>`), so staging and production cannot share a faucet key.
- 113cd50: Faucet robustness (M1-10b-c). When an earlier `approve` from the faucet wallet is still pending (its `pending` nonce is above its `latest` one), a claim that needs a new approve is refused at once with the retryable `busy` (the HTTP answer stays `unavailable`) and nothing is sent, so a stuck approve can no longer wedge later claims. Every faucet gas limit is capped at `FAUCET_MAX_GAS` (300k): a simulation above it is refused, not clamped, and nothing is sent.
- b155084: Faucet: a claim that needs a new `approve` while the faucet wallet's previous transaction is still pending now waits for it (polling the `latest` nonce, within the same `receiptTimeoutMs` budget as the approve's receipt wait) and refuses with `busy` only if it is still pending at the deadline (M1-10b-d). Two claims within about one block no longer get a retryable `unavailable`.
- cb4a63a: Owner approvals, policies and revocations, envelopes, agent cards and proof packs are now checked from the exact text received: text that repeats a field name or spells one with an escape sequence is refused as malformed before the signature is checked (M1-1h-b, D-128). New in `@4thtech-io/crypto`: `parseReceivedJson`, `parseEnvelopeText` and the `plainMemberNames` option of `parseJson`.
- 320bc9e: Receipts covered by the sender's proof fee (M1-34-b, D-114). The submitter accepts up to 3 receipts for a record the Notary stores (its NOTARIZE fee was charged), whatever the recipient holds: one `getRecord` read per record before simulation; a receipt for an unknown record is `failed` with `RecordNotFound`, a new type over the cap (on-chain plus in flight) with `receipt_limit`, and ACCEPTED against REJECTED in flight with `ConflictingReceipt`. The chain port gains `recordReceipts` and `MAX_RECEIPTS_PER_RECORD`. `createProofSubmitter` never sends a receipt in direct mode unless `directReceipts: true`, so the recipient's own account never pays for it unasked; a receipt no submitter takes is `pending`. `ProofSubmitter.acknowledge` takes an optional per-call `waitMs`. The core posts queued receipts (`postQueuedReceipts`, at most 5 per pass, least recently tried first, 2 s wait each) after each sync pass's new envelopes, the same signed bytes until they land; a receipt the chain refuses for good (`RecordNotFound`, `InvalidSignature`, `NotRecipient`) becomes `receipt_failed` and is not retried.
- 5864ac4: M1-3j-b: automatic selection (`autoSelectableChains()`, the default proof networks) now uses exactly the registry chains the testnet faucet serves (07 §6.3, D-40), so an unfunded payer is never routed to a chain where it cannot get credits. Gnosis Chiado (10200) joins automatically once the faucet allowlist names it; in this release that is still Base Sepolia only, so routing is unchanged.
- 7b053cc: M1-3j-c: Gnosis Chiado (10200) is on the testnet faucet allowlist (`FAUCET_CHAIN_IDS` = 84532, 10200), so it joins automatic selection beside Base Sepolia (07 §6.3, D-40). The submitter serves Chiado and its faucet in staging and production (`SUBMITTER_CHAINS` and `SUBMITTER_FAUCET_CHAINS` = `84532,10200`, a distinct pinned faucet wallet per environment). The faucet credits Chiado's native xDAI with one `depositFor` carrying the amount (D-46).
- e2a5052: The submitter's chain port now reads a record as "absent" only from the Notary's `RecordNotFound()` revert. A returned record with a zero signer is a bad answer, like any other revert, a revert without data, a transport error, a timeout or an empty result, so the submitter answers `unavailable` and never signs a record or refuses a receipt on a failed read (M1-4c-c).
- 9676c15: The chain-state `getRecord` treats a returned record with a zero signer as a bad chain answer (`bad_answer`, retryable), never as "no record". Only the Notary's `RecordNotFound()` revert means absent, so a misbehaving RPC can no longer make the client sign a replacement or send a record twice.
- 5c19ee0: The proof-pack verifier reads a `getRecord` revert as "no such record" only when its data is exactly the `RecordNotFound()` selector, as the submitter port does; revert data with trailing bytes stays `chain_unavailable`. A returned record with a zero signer is now `malformed_record` instead of `record_not_found`, and no other block is read for it. `ChainError` gains `revertBare` (true when the revert data was exactly a 4-byte selector).
- 1cd25e4: The read client's `getRecord` returns "no such record" only when the revert data is exactly the `RecordNotFound()` selector; the same selector with trailing bytes, an `Error(string)` naming it, or an empty revert stays a `call_reverted` failure, so no replacement proof is decided on it (M1-4d-h).
- 62e8d42: M3-4b-t-0: the private `@4thtech-io/occ-v2-abi` package now carries contracts release `v0.1.0-testnet.4`: Base Sepolia's vault accepts `depositWithAuthorization` (capability true, USDC `eip3009` true; Gnosis Chiado stays false) and the ABIs add the `DepositMismatch()` error. `depositWithAuthorization` is re-tagged `relay` and exported only in the new submitter-side `occFeeVaultRelayAbi`; the client ABI still excludes it. `@4thtech-io/chain` pins the new release (`OCC_V2_ABI_PIN`) and adds the `GASLESS_TOPUP_ENABLED = false` kill switch in the chain registry, so no fee token is composed `eip3009` until M3-4b-t-4.
- d48cc3f: M3-4b-t-T2-b: the gasless authorization builder now signs a window of at most 15 minutes (`GASLESS_MAX_WINDOW_SECONDS` = 900, was 3600), the same bound the relay checks (`validBefore` at most now + 900 + 120 s skew). Both relay checks read the one constant. Stale "until M1-3c" comments updated; a registry-level test covers the `GASLESS_TOPUP_ENABLED` kill switch.
- Updated dependencies [27437fc]
- Updated dependencies [cb4a63a]
- Updated dependencies [52c8fe8]
- Updated dependencies [de8696b]
- Updated dependencies [e7aeadf]
- Updated dependencies [70e362b]
- Updated dependencies [3a3837b]
- Updated dependencies [0f13f71]
- Updated dependencies [1d10f83]
- Updated dependencies [0ece43e]
- Updated dependencies [c6aa21f]
- Updated dependencies [62e8d42]
- Updated dependencies [9dbaa44]
  - @4thtech-io/types@0.2.0
  - @4thtech-io/crypto@0.2.0
  - @4thtech-io/occ-v2-abi@0.0.2

## 0.1.2

### Patch Changes

- 8c9cdd1: M1-10a-b: the submitter's chain port adds `latestNonce()` (mined transactions only). The submitter resubmits a shared revert with no identifiable cause split per signer, reconciles a given-up transaction against the `latest` nonce so no nonce is skipped, and keeps an item in flight when the chain cannot be read while re-simulating it after a revert.
- 1753640: M1-10a: the submitter. `@4thtech-io/chain` adds the submitter wire format (`parseSubmitRequest`, `parseSubmitResponse`, `parseStatusResponse`, `parseHealthResponse`), the local EOA signature check (`itemSignatureMatches`), the Worker's chain port (`createSubmitterChain`: per-item and batch simulation, the gas-key wallet, inclusion from the receipt's Notary events) and the client with failover (`createSubmitterClient`). `@4thtech-io/submitter` is the Worker: `/v1/notarize`, `/v1/receipt`, `/v1/status/:txHash`, `/v1/health`, and `/v1/deposit-authorization` disabled; G-4 batching, FA-1 code-bearing signers solo and gas limit = simulated gas + margin, FA-3 items already on-chain skipped and not sent, per-IP and per-signer limits, per-chain nonce serialisation in a Durable Object, items held while the Notary is paused.
- 75737c8: M1-10b: the testnet credits faucet. `@4thtech-io/chain` adds the hard-coded faucet chain allowlist (`FAUCET_CHAIN_IDS`, `isFaucetChain`: Base Sepolia until Chiado is deployed), `buildDepositFor` (an exact `approve`, then `depositFor(agent, token, amount)`) and the faucet wallet (`createFaucetChain`), which refuses any chain off the allowlist and sends nothing until the chain ID, balances and simulation pass. `@4thtech-io/submitter` adds `POST /v1/faucet` with one claim per agent per window, claims per IP per day, a global daily cap per chain, a per-IP request limit, and a Durable Object per chain that serialises claims so the caps hold under concurrency.
- 6c759e0: M1-26: zero-config chain selection (07 §6.3, D-40). `detectFunding` reads, in parallel and within a short per-chain budget, the fee quote, `creditsOf` and (only where a gasless top-up exists) the stablecoin balance on every selectable chain; a chain that fails or is late is listed as unavailable. `pickChain` picks the default chain if funded, otherwise the cheapest funded chain, otherwise returns `needs_credits` with a top-up route (chain, token, amount to add in USD: the shortfall, at least `minDeposit` where gasless; the fee; agent address) to the cheapest chain. Tie-breaks are by fee, then credits before a top-up, then the lower chain ID. The default chain matches a network family (`base` → `base-sepolia`). Mainnet entries (flag or known chain ID) are never queried, picked or offered. `selectPayingChain` combines both; `createChainSelector` adds a 60 s detection cache that reuses only funded selections.
- 2b11a8d: M1-3f: new private package `@4thtech-io/occ-v2-abi` with the OCC v2 contract ABIs and the Base Sepolia testnet addresses from contracts release `v0.1.0-testnet.2`, verified against its SHA-256 manifest and bundled into the CLI, never published (D-83). It exports client-safe Notary and vault ABIs without admin, upgrade or module functions. `@4thtech-io/chain` pins that release (`OCC_V2_ABI_PIN`) and loads its contracts with EIP-55 checksummed addresses (`loadOccV2Contracts`, viem `getAddress`).
- 85b6c1d: M1-3j: the private `@4thtech-io/occ-v2-abi` package now carries contracts release `v0.1.0-testnet.3`: the same ABIs plus the Gnosis Chiado (10200) addresses, deployed on 2026-10-19 with the Base Sepolia addresses. `@4thtech-io/chain` pins the new release (`OCC_V2_ABI_PIN`) and its registry now lists Chiado with its native fee asset. New `autoSelectableChains()` keeps Chiado out of automatic selection (M1-3j-b); only an explicit chain override may name it.
- bc3bfe4: M1-4a: the chain client foundation. A supported-chain registry composed from the shipped network entries and the pinned `@4thtech-io/occ-v2-abi` release (Base Sepolia today), automatic testnet-only chain selection, an RPC URL rule (04 §4: https, public host name, no key), a read-only viem client per chain with a fallback transport, timeouts and retries, calls encoded only from the client-safe ABIs, `Record`, `Receipt` and `AgentCard` builders with EIP-712 vector parity and signing through `KeyStore.sign712`, a fresh CSPRNG salt and nonce for every Record, and the Notary's record ID derivation. Read-client errors are fixed-code `ChainError`s with no RPC URL. `@4thtech-io/node` adds `nodeRpcFetch`, the RPC fetch that refuses private and loopback addresses at resolve time and pins the checked address per request (04 §4).
- 5a9ee7d: M1-4b: fee quotes in USD (`quoteFee`: the vault's `quote` with the protocol and integrator parts, 1:1 for the stablecoin fee tokens, fail-closed when the parts do not add up), credits per chain and across chains (`readCredits`, `readCreditsAcrossChains`), the direct-mode deposit helper (`buildDeposit`: exact-amount approve, then deposit; sends nothing) and the credit event filter (`filterCreditEvents`, `readCreditHistory`: canonical vault only, zero-amount events ignored). Only offered allowlisted fee tokens are priced, shown or deposited. The read client is now a frozen view of the viem client: `extend` stays wrapped, namespaced actions and `onError` callbacks get URL-free `ChainError`s, and the transport exposes no RPC URL. `createReadClient` accepts only the address-checked fetch; `@4thtech-io/node` `nodeRpcFetch` carries that brand.
- 248b9af: M1-4c: submission, direct mode and inclusion tracking (07 §6.2, §7; 04 §5, §7). `createProofSubmitter` sends a signed Record or Receipt through up to five submitters, then direct mode from the agent's own account (the same one-item `notarizeBatch` when credits cover the fee, otherwise `notarizeDirect`, which pays now after an exact `approve(maxFee)` or with `maxFee` as the native value; `acknowledge` for receipts), and decides every outcome from chain reads (`recorded`, `needs_credits`, `pending`, `failed`, `conflict`); it signs nothing and resends only the same signed item. `replacementAllowed` is the 04 §5 check at the `finalized` block (or the configured depth). `readInclusion` tracks inclusion and confirmations. `createChainState` is the read port; `sendDirect` simulates, has an injected `DirectSigner` sign, checks the signed bytes and broadcasts through `createBroadcaster` (address-checked fetch only). Deposits: `buildDeposit` takes the current allowance (exact reuse, or a reset to 0 first for USDT-style tokens), `planDeposit` reads it, `sendDeposit` checks the steps against the request (token, amount, values, order), sends them and then clears the selector and selects again once; `checkGaslessTopUp` enforces the `eip3009` flag and `minDeposit` and builds nothing (D-89). `selectAgain` clears the selection cache and selects once.
  
  The default submitter at submit.agentlink.4thtech.io is not deployed yet, so proofs need it before they work out of the box.
- 92871c9: M1-4d-b: `verifyProofPack` checks the signer's agent card when the pack carries one (`cardSig` by the card's `ownerEvm`, `agentEvm` = signer and ≠ `ownerEvm`, not expired at the record time; else `card_invalid` or `card_expired`) and reports it as `signerCard`. Disclosed content names its `sender` (the envelope's `from`). With a card, the sender must be the card's `agentNostr`, else the content fails `sender_mismatch`. Content that opens is `unattributed`: `sender_not_bound` without a card, `sender_attribution_pending` with one (interim rule: `verdict` stays `record_only`; full sender attribution is in development, M1-4d-d).
- 3c350b7: M1-4d-c: `verifyProofPack` cross-checks `receiptFlags` with `receiptAt` (D-97: type `t` is bit `t − 1`, bits 4–7 zero, ACCEPTED and REJECTED never both; any mismatch is `malformed_record`); reports a contract-account signer whose `isValidSignature` no longer accepts the pack's signature with the non-fatal notice `signer_no_longer_confirms`, the verdict unchanged (D-96); checks each listed receipt's `txHash` with one transaction-receipt read (`receipts[].tx`: `confirmed`, `not_checked` or `mismatch`, the last with the non-fatal notice `receipt_tx_mismatch`); and checks the pack's signed owner approval against the record and the signer's card (`ownerApproval`; an invalid one fails with `owner_approval_invalid`; a signer-side approval is bound to the record through its disclosed content, terms hash and, for an accept, `replyTo`, and is reported `recordBound: false` without content), or reports a standing rule's policy hash. New result fields: `notices`, `ownerApproval`, `receipts[].tx`.
- 50340cb: M1-4d: `verifyProofPack(pack, {chains})` checks a proof pack (07 §8) against `getRecord` on the pack's supported chain and the shipped Notary: record ID, struct hash, signer, kind, envelope hash and commitment; the signature (canonical ECDSA, else ERC-1271 `isValidSignature`); a disclosed recipient; receipts from `RecordState`; and a disclosed content key in the 07 §8 order (G-46) with the D-86 kind check. A top-level `verdict` (`verified`, `record_only`, `failed`) and `finality` (`finalized`, else `latest`). Strict parsing (256 KiB cap, strict JSON, the types schema); fixed failure codes and messages (`PROOF_PACK_FAILURES`, `PROOF_CONTENT_FAILURES`, `proofFailureMessage`); `recordKindForPayload`. `@4thtech-io/types`: `isRecordSignature` takes any `0x` + even-hex signature (04 §2.4.1 clarified: the canonical ECDSA form is required only on the EOA recovery path, as in the Notary's SignatureChecker).
- 2e6b70e: M1-4d-d-b: the agent card's proof of possession (04 §2.9, D-102). `TAGS.cardPop` (`agentlink/card-pop/v1`), `verifyCardPop`, `verifyCardPossession` and `cardPopSnapshot` are in the crypto main entry; the raw-key `signCardPop` is in the restricted `@4thtech-io/crypto/keystore` entry. `KeyStore.signCardPop(card)` signs only the store's own card at its current key epoch and refuses anything else with one fixed error; implemented by `MemoryKeyStore` and the keychain KeyStore (and its facade). The `handshake` and `handshake-ack` bodies take an optional `cardPop`, and `card-update` optional `cardAgentSig` and `cardPop`, together or not at all. The core makes `cardPop` with every own card (init, so also `owner add-agent`, and rotation once the KeyStore is at the new epoch; a card stored before this change gets one on first use), sends it in `handshake` and `handshake-ack`, verifies a received pair in `handshake`, `handshake-ack` and `card-update` (a present signature that does not verify drops the whole body), and stores a contact's verified pair. `proofSigner(from)` returns the signer block with the pair for the upcoming `exportProofPack` (M1-7g); the core does not yet send `card-update` itself. `verifyProofPack` uses the crypto check instead of its own composition (no behaviour change).
- c5b21ee: M1-4d-d: proof packs may carry the signer card's proof of possession, `signer.cardAgentSig` (agent EVM key, EIP-712 over the card) and `signer.cardPop` (BIP-340 by the card's `agentNostr` over `taggedHash("agentlink/card-pop/v1", sha256(JCS(card)))`), together and only with `agentCard` (else `malformed_pack`). `verifyProofPack` checks both after the card checks: either one that does not verify over this exact card fails the pack with `card_pop_invalid`; with both valid and an ECDSA signer, content that passes every step is `verified` and so is the verdict. A card without them, or a contract-account signer, keeps the content `unattributed` with `card_pop_missing`, which replaces `sender_attribution_pending`.
- Updated dependencies [dd9650b]
- Updated dependencies [4d7d3e4]
- Updated dependencies [2b11a8d]
- Updated dependencies [85b6c1d]
- Updated dependencies [50340cb]
- Updated dependencies [2e6b70e]
- Updated dependencies [c5b21ee]
- Updated dependencies [49eb7be]
  - @4thtech-io/crypto@0.1.2
  - @4thtech-io/occ-v2-abi@0.0.1
  - @4thtech-io/types@0.1.2

## 0.1.1

### Patch Changes

- Updated dependencies [4dcc340]
- Updated dependencies [af00aaa]
- Updated dependencies [b26ef46]
- Updated dependencies [2a6716d]
- Updated dependencies [e768cd1]
- Updated dependencies [58df129]
  - @agentlink/crypto@0.1.1
  - @agentlink/types@0.1.1

## 0.1.0

### Patch Changes

- 67c88fb: Adds the launch-testnet chain configuration: Base Sepolia with Circle's USDC, and Gnosis Chiado with xDAI. Also adds the USD fee schedule ($0.10 per proof with a $0.50 cap, $5 per registration with a $25 cap, $5 minimum deposit) and a config check. The check accepts only USD stablecoins, allows the native coin only on Gnosis, requires a source for every entry and accepts only keyless public RPC URLs with a host. Each chain also records whether it answers the `finalized` block tag.
- Updated dependencies [0baa0a5]
- Updated dependencies [7121fa2]
- Updated dependencies [2172526]
- Updated dependencies [9c27388]
- Updated dependencies [32b70f5]
- Updated dependencies [cb7c956]
- Updated dependencies [fecd9a3]
- Updated dependencies [4287032]
- Updated dependencies [1feb21c]
- Updated dependencies [d8228d2]
- Updated dependencies [39b1d8c]
- Updated dependencies [427592d]
- Updated dependencies [e6a146d]
- Updated dependencies [a71148b]
- Updated dependencies [810e746]
- Updated dependencies [7470286]
- Updated dependencies [667dc38]
- Updated dependencies [9722c8a]
- Updated dependencies [66e997c]
- Updated dependencies [e02996f]
- Updated dependencies [a1465a6]
  - @agentlink/crypto@0.1.0
  - @agentlink/types@0.1.0
