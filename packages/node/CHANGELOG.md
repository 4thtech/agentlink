# @4thtech-io/node

## 0.2.0

### Minor Changes

- 66d6279: The local web app's Activity page (M1-11c-a1): `GET /api/ui/activity` returns one page of the activity feed (approvals decided, including those approved by your rules, proofs, blocked senders and contacts, rules updated) through the read-only client view, with only the display fields each kind needs, and the page shows it newest first with "Show more", an empty state and clear loading and error states.
- 342d345: The local approval server can serve the local web app (D-118): an in-memory bundle of its built files under `/assets/`, its page at `/first-run` and `/settings`, and a `/api/ui/` route registry in which every change needs owner presence, checked centrally before the route runs. `/` and `/approve/<id>` keep the approval page. The CLI embeds the app's build when present.
- 76ad5c5: The local approval server can set up the owner from the first-run page (M1-11s-c, D-120 (1)): two setup routes, behind their own setup gate and only while no owner exists anywhere, create the owner key with one passkey gesture, a backup owner code shown once, and the agent's first card, all or nothing. The owner seed is held in memory for at most two minutes between the two steps, for one session, and wiped after. When an owner is set up from the page, the CLI logs a fixed line with the owner fingerprint to compare with `agentlink doctor`.
- eacf0bc: `agentlink owner init` and `agentlink owner add-agent` now also allow an empty `AgentLink/Send` folder in your home folder for sending files, in the same owner code entry as the agent's card. Nothing else changes in your rules.
- 8095c0c: M1-8f (D-54, 04 §2.8): the passphrase-locked file KeyStore for headless machines, opt-in only. `createFileKeyStoreAgent` creates an agent in `~/.agentlink/keystore/<agentId>.alks` only when the OS keychain probe fails, from an interactive terminal with no AI-app marker set, with a generated unlock code by default. `unlockFileKeyStoreAgent` reads the unlock secret from `AGENTLINK_KEYSTORE_PASSPHRASE_FILE`, then `AGENTLINK_KEYSTORE_PASSPHRASE` (both removed from the environment), then an optional prompt, and keeps only the derived key in memory. `changeFileKeyStorePassphrase` re-wraps the file under a new secret. `openAgentKeyStore` and `openAgentStore` take the unlocked handle as `fileAgent` for the recorded backend `file`. The policy-version mark and the receipts-kept marker are `ALKS` entries written with the 04 §2.8 write protocol. Nothing changes for keychain agents.

### Patch Changes

- 55d5b9d: The local app's first-run page (M1-11b-1, D-120): protect approvals with one passkey, see your owner fingerprint and a backup owner code (collapsed), put the recovery kit off with "Later", and go back to your AI with a prompt to copy. A new read route, `GET /api/ui/first-run`, says only whether approvals are protected yet. The shared page states (link expired, AgentLink not running, setup unfinished, recovery kit reminder, network, empty, loading and error) follow the d1 design. The page is included but not yet opened or connected by the CLI, so it is usable from the next release (M1-11b-6).
- 458c32c: Owner setup on the first-run page refuses, before anything is read or written, a held seed that is not the owner the page was shown (M1-11s-c-b). Tests: the setup canary now covers the seed and the PRF output in every encoding, using a canary seed that is never a real seed.
- 0e5fef3: Delete after receipt now applies only to files sent while it was on: turning it on later never deletes files sent earlier, and files sent before this update are kept until they expire (M1-1g-i).
- 52c8fe8: M1-33a (D-109): delivery receipts are off by default. `@4thtech-io/types`: the 06 §3 default `receipts.autoDelivered` is `false`; a `ContactRule` may carry `receipts: {autoDelivered}` (strict) with or without `proofs`, and needs at least one of the two. `@4thtech-io/core`: an automatic DELIVERED receipt uses the record signer's contact rule when that contact is paired and not blocked or revoked, else the global value; under failing rules none is signed. OPENED, ACCEPTED and REJECTED are unchanged. `@4thtech-io/core` also adds `receiptsOnFromOlderDefault` and `recordReceiptsKept` on `OwnerActions` and the `receiptsKept` client option (a `ReceiptsKeptMark`). `@4thtech-io/node`: the receipts-kept marker as the keychain item `<agentId>:receipts-kept`, on `AgentStore.receiptsKept`. `@4thtech-io/agentlink`: the rules review lists a contact's delivery-receipt rule; a policy signed earlier keeps its value until the owner next signs their rules, which then asks "Keep delivery receipts on?" and turns them off unless the owner types y (a yes is remembered); until then `agentlink doctor` shows the older-default line.
- 76b7e47: M1-36a-b: every "run this" line in `init`, `doctor`, the owner commands, the not-set-up message, the approval page and the owner setup steps now starts with a command that works on your computer: `agentlink` only after a global install, otherwise `npx -y @4thtech-io/agentlink`. The approval page no longer points to `agentlink ui`, which does not exist; it names `approve` instead. When your AI checks AgentLink on a computer that has no owner yet, it now tells you to run `owner init` instead of `owner add-agent`.
- 40e73bb: M1-36e: the last "run this" lines that still started with the bare `agentlink` (`doctor`, `policy`, `requests`, `credits`, `contacts`, the not-set-up and error messages, the tool hints for your AI, and the key, keychain, add-agent and change-code messages) now start with a command that works on your computer: `agentlink` only after a global install, otherwise `npx -y @4thtech-io/agentlink`. `doctor` and `status` say "message network" instead of "relays". A vocabulary check now keeps terminal text, tool hints, the approval page and the user guide free of technical words such as wallet, gas, transaction and chain.
- 3a3837b: `KeyStore.signTransaction` signs one direct-mode transaction with the agent's EVM key, on the launch testnets only: EIP-1559, to the AgentLink Notary, fee vault or an offered fee token, with a direct-mode call (`notarizeDirect`, `notarizeBatch`, `acknowledge`, `acknowledgeBatch`, `deposit`, `withdraw` to the agent's own address, `approve` of the vault), bounded value, calldata, gas and fees. Everything else is refused with `transaction_refused` before any key is read. The keychain KeyStore implements it. `@4thtech-io/chain` adds `keyStoreDirectSigner`, `createDirectMode` (testnets of the KeyStore allowlist only), the typed `buildWithdraw` and `sendWithdraw`, and the ChainError code `signing_refused`.
- f8c4440: The SQLite agent store opens with `secure_delete = ON` (M1-7f-2; 04 §4 crypto-shredding), so deleted rows, sealed file keys among them, are zeroed on disk. `SqliteStore.readSetting` also reads `secure_delete`.
- 1d10f83: Owner-signed own storage and recovery-kit export (M1-9i-a, D-115). `@4thtech-io/types` adds the `storage.set`, `storage.remove` and `backup.export` owner actions with strict params (L(op) = 600 s), `STORAGE_PROVIDERS`, `BACKUP_KIT_CONTENTS` and `isCanonicalS3Endpoint`. `@4thtech-io/core` applies them (nonce row and the one `own_storage` row in one transaction, then the KeyStore `storage-mark`), adds `ownStorage.load()` (`none`, `ready` or `broken`, re-verified on every load, never by expiry), the `OwnStorageKeys` interface and the `storage-mark` codec, and the `brokenOwnStorageAdapter` stub: a broken own storage makes a stored file send `needs_setup` `storage_broken`, never the drop. Store schema version 5 adds `own_storage`; `@4thtech-io/node` migrates SQLite stores to it.
- 25d121c: Groundwork for backup and restore, with no user commands yet (M1-9i-c): the keychain and file backends implement the recovery-kit export and import controls and the storage credential control, with the restore quarantine and its snapshot checks, the own-storage items on the agent store, and a refusal of a nested inter-process lock in the same flow. Not reachable from the package entry yet; the CLI owner commands wire them (M1-9i).
- Updated dependencies [b5c51e6]
- Updated dependencies [27437fc]
- Updated dependencies [be16e36]
- Updated dependencies [8928493]
- Updated dependencies [cf800d0]
- Updated dependencies [0e5fef3]
- Updated dependencies [cb4a63a]
- Updated dependencies [52c8fe8]
- Updated dependencies [bc8d9f3]
- Updated dependencies [16f692e]
- Updated dependencies [70e362b]
- Updated dependencies [320bc9e]
- Updated dependencies [19c8626]
- Updated dependencies [3a3837b]
- Updated dependencies [068d989]
- Updated dependencies [068d989]
- Updated dependencies [ec598ee]
- Updated dependencies [d311d76]
- Updated dependencies [ca60f25]
- Updated dependencies [f8c4440]
- Updated dependencies [0f13f71]
- Updated dependencies [8621ff4]
- Updated dependencies [4be1e27]
- Updated dependencies [e7ac634]
- Updated dependencies [31957b7]
- Updated dependencies [3a08533]
- Updated dependencies [6055f38]
- Updated dependencies [1d10f83]
- Updated dependencies [0ece43e]
- Updated dependencies [c6aa21f]
- Updated dependencies [821ac87]
- Updated dependencies [8565521]
- Updated dependencies [529a0f6]
- Updated dependencies [9dbaa44]
- Updated dependencies [c6546b9]
  - @4thtech-io/core@0.2.0
  - @4thtech-io/crypto@0.2.0
  - @4thtech-io/transport-nostr@0.2.0

## 0.1.2

### Patch Changes

- dd9650b: M1-1g-e: `KeyStore.signDropRequest(request, createdAt)` signs one encrypted-drop request with the agent's separate drop key at the current epoch and returns the `Authorization` header (07 §5.4). It is the `DropSigner` the drop adapter takes. The KeyStore fixes the event kind (27235) and the `domain` tag, signs only POST and DELETE to an https URL in serialised form over the drop's signed JSON body with `createdAt` equal to its `ts`, and refuses anything else with one fixed error before reading any key. Implemented by `MemoryKeyStore` and the keychain KeyStore (and its facade). `dropRequestSnapshot` and `DROP_REQUEST_REFUSED` are in the main entry; the raw-key `signDropRequest` is in the restricted `@4thtech-io/crypto/keystore` entry.
- 4d7d3e4: M1-1g-f: `KeyStore.signDropRequest(request, createdAt, options?)` takes an optional `{epoch}` for a DELETE, so an object uploaded under an older key epoch stays deletable after a rotation (04 §2.1). It is accepted only with DELETE and never above the current epoch (`epoch_unavailable`); a POST with an epoch or a malformed epoch gets the same fixed refusal, and every check runs before a key is read. Implemented by `MemoryKeyStore` and the keychain KeyStore (and its facade). `dropRequestEpoch` joins `dropRequestSnapshot` in the main entry.
- bc3bfe4: M1-4a: the chain client foundation. A supported-chain registry composed from the shipped network entries and the pinned `@4thtech-io/occ-v2-abi` release (Base Sepolia today), automatic testnet-only chain selection, an RPC URL rule (04 §4: https, public host name, no key), a read-only viem client per chain with a fallback transport, timeouts and retries, calls encoded only from the client-safe ABIs, `Record`, `Receipt` and `AgentCard` builders with EIP-712 vector parity and signing through `KeyStore.sign712`, a fresh CSPRNG salt and nonce for every Record, and the Notary's record ID derivation. Read-client errors are fixed-code `ChainError`s with no RPC URL. `@4thtech-io/node` adds `nodeRpcFetch`, the RPC fetch that refuses private and loopback addresses at resolve time and pins the checked address per request (04 §4).
- 5a9ee7d: M1-4b: fee quotes in USD (`quoteFee`: the vault's `quote` with the protocol and integrator parts, 1:1 for the stablecoin fee tokens, fail-closed when the parts do not add up), credits per chain and across chains (`readCredits`, `readCreditsAcrossChains`), the direct-mode deposit helper (`buildDeposit`: exact-amount approve, then deposit; sends nothing) and the credit event filter (`filterCreditEvents`, `readCreditHistory`: canonical vault only, zero-amount events ignored). Only offered allowlisted fee tokens are priced, shown or deposited. The read client is now a frozen view of the viem client: `extend` stays wrapped, namespaced actions and `onError` callbacks get URL-free `ChainError`s, and the transport exposes no RPC URL. `createReadClient` accepts only the address-checked fetch; `@4thtech-io/node` `nodeRpcFetch` carries that brand.
- 2e6b70e: M1-4d-d-b: the agent card's proof of possession (04 §2.9, D-102). `TAGS.cardPop` (`agentlink/card-pop/v1`), `verifyCardPop`, `verifyCardPossession` and `cardPopSnapshot` are in the crypto main entry; the raw-key `signCardPop` is in the restricted `@4thtech-io/crypto/keystore` entry. `KeyStore.signCardPop(card)` signs only the store's own card at its current key epoch and refuses anything else with one fixed error; implemented by `MemoryKeyStore` and the keychain KeyStore (and its facade). The `handshake` and `handshake-ack` bodies take an optional `cardPop`, and `card-update` optional `cardAgentSig` and `cardPop`, together or not at all. The core makes `cardPop` with every own card (init, so also `owner add-agent`, and rotation once the KeyStore is at the new epoch; a card stored before this change gets one on first use), sends it in `handshake` and `handshake-ack`, verifies a received pair in `handshake`, `handshake-ack` and `card-update` (a present signature that does not verify drops the whole body), and stores a contact's verified pair. `proofSigner(from)` returns the signer block with the pair for the upcoming `exportProofPack` (M1-7g); the core does not yet send `card-update` itself. `verifyProofPack` uses the crypto check instead of its own composition (no behaviour change).
- Updated dependencies [b63fd4e]
- Updated dependencies [dd9650b]
- Updated dependencies [4d7d3e4]
- Updated dependencies [84bda36]
- Updated dependencies [2e6b70e]
- Updated dependencies [bdf5da6]
- Updated dependencies [19e234d]
- Updated dependencies [49eb7be]
- Updated dependencies [c6eb603]
  - @4thtech-io/core@0.1.2
  - @4thtech-io/crypto@0.1.2
  - @4thtech-io/transport-nostr@0.1.2

## 0.1.1

### Patch Changes

- 8a3f76e: Local approval page (not opened by the CLI yet): review your waiting approvals together and confirm the list with one passkey or owner code entry (terms are still approved one at a time); each page link opens once; repeated wrong owner codes make you wait before the next try.
- 5773ac4: M1-15-b: Windows path-guard fixes: tests run on Windows with no skip; a folder swap is refused check→open on every OS, and post-open where the OS allows it.
- 053a2cb: M1-15: SSRF-safe download (DNS-pinned, at most 2 re-checked redirects, byte cap, deadline), allowed-folder path guard with realpath on both sides, and a download file-name sanitiser. Not wired into any tool yet.
- e3b9df1: The local approval page now opens at `http://localhost:<port>` (listening on 127.0.0.1 and ::1 on the same port), so a browser passkey can be used for approvals later.
- 42497b7: Adds the local approval server (not wired into the CLI yet): it runs on 127.0.0.1, shows pending approvals, and every approve or deny needs your owner code or owner passphrase.
- c00bc2f: Adds the localhost passkey to the local approval server (not wired into the CLI yet): set up a passkey with your owner code once, then approve or deny with it; the owner code keeps working.
- e768cd1: `owner add-agent` recovers an owner with no attached agent: the owner keys come from the saved owner itself after the owner code, and the owner confirms the fingerprint (M1-9x).
- 1ba92cb: Add `agentlink owner change-code` to replace an exposed owner code without changing the owner
- 58df129: M1-9za: owner commands `contacts rename` and `contacts remove`, signed as the new owner actions `contact.rename` and `contact.remove`; `contacts` lists each contact's ID.
- Updated dependencies [088b5fd]
- Updated dependencies [053a2cb]
- Updated dependencies [4dcc340]
- Updated dependencies [af00aaa]
- Updated dependencies [b26ef46]
- Updated dependencies [2a6716d]
- Updated dependencies [e768cd1]
- Updated dependencies [58df129]
  - @agentlink/core@0.1.1
  - @agentlink/transport-nostr@0.1.1
  - @agentlink/crypto@0.1.1

## 0.1.0

### Minor Changes

- 832fc4f: Add the Node relay connector, host resolver and NIP-11 fetcher for the relay pool of `@agentlink/transport-nostr`. Each relay connection goes to the address the pool checked, never to a second lookup of the name, with TLS and the `Host` header on the relay's host name; redirects are refused and proxy settings are ignored, for the WebSocket and for the NIP-11 read. Inbound messages over 131 072 bytes close the socket before they reach the pool, compression is not negotiated, and the NIP-11 read is capped at 65 536 bytes with its own 5-second deadline. New dependency: `ws` 8.22.0 (no dependencies, no install script).
- af1ce64: Add the owner's answers to requests from unknown senders and refused-row retention to the core (M1-7e-2, D-72). `client.requests` gains `accept(requestId)` (flags that one request row readable; it still counts toward the limits, and no contact or pairing is written), `ignore(fromKey)` (now also removes the key's refusals), `ignoreAll()`, `block(requestId)` (adds the key to `blocked_keys` and removes its requests, refusals and held envelopes in one transaction), `unblock(fromKey)` (by key, never by the sender-chosen envelope ID) and `listBlocked()`; `list()` entries carry `acceptedAt`. Envelopes from a blocked key are dropped at the start of 04 §3.1.1 step 5, before any decryption, with the new fixed reason `sender_blocked`; a contact's card-update from a blocked new epoch key still applies and removes the block, and a pairing message from a blocked key is always dropped. Refusals from unknown keys stop counting 7 days after the local `refused_at` (or when `refused_at` is more than 300 s ahead) and are pruned at the start of each processing pass. `requestsFullTx` now takes `now`. The idempotency `begin` refuses a `clientRequestId` outside 1 to 256 UTF-8 bytes and a tool name outside the 06 §2.0 set with `idempotency_args_invalid`. Store schema version 2: `envelopes.refused_at`, `envelopes.request_accepted_at` and the `blocked_keys` table; the Node SQLite store migrates a version 1 file forward.
- 065d02d: Add the OS keychain KeyStore: the agent's keys on macOS Keychain, Windows Credential Manager and the Linux Secret Service, under service `agentlink` and one account per agent, so several agents share a machine. The agent's identity is read from the keychain for each operation, checked against the agent ID, used and wiped; a missing or mismatched item is an error with a fix and never creates a new identity. Includes creating an agent in the keychain (never overwriting), the keychain probe and the backend choice at setup: without a usable keychain the answer is `needs_setup` unless the user opted in to the passphrase-locked file, which lands later.
- e02996f: Add the agent's local store on SQLite: every table of the store schema, with its keys, unique constraints, value types and row limits enforced by SQLite itself, forward-only migrations (a store written by a newer version is refused, never downgraded), WAL mode and write transactions that several processes can share for one agent, and an inter-process lock for longer critical sections. Sensitive columns are encrypted at rest with AES-256-GCM under the agent's store key from the keychain, bound to their table, column and row, and keyed digests use an index key derived from the store key. `@agentlink/crypto/keystore` gains the store column cipher.
- b4b340c: Add owner presence at a terminal prompt (M1-8c, D-67, D-68). `initOwner` creates the owner key on a keychain machine as the `agentlink`/`owner` keychain item in its locked `ALKO` form, under a generated owner code (or a chosen owner passphrase of at least 12 characters after an explicit opt-in), and never replaces an existing owner. `performOwnerOperation` signs one owner action or one piece of typed data, and `decideReviewedApprovals` signs reviewed approvals as one `approval.decide` or one `approval.decideBatch` (2 to 20 items, commitments never batched). Each asks for the owner code once at an interactive terminal, never from an environment variable, file, argument or pipe, and closes the owner session and wipes the code and the unlocked key when it returns. New error codes on `NodeKeyStoreError`: `owner_missing`, `owner_exists`, `owner_mismatch`, `owner_prompt_unavailable`, `owner_prompt_cancelled`, `owner_secret_refused`, `harness_detected` and `owner_operation_invalid`.
- 5844fea: Add the policy-version mark that protects an owner-signed policy from being rolled back. It is kept as a keychain item next to the agent's keys, rises only, under the agent's inter-process lock, and is read back after each update; a damaged item locks the policy instead of counting as "no policy yet". `openAgentStore` now returns it as `policyMark`, so a Node client passes it to the core and can apply owner-signed policies.

### Patch Changes

- e1f2ba0: Adds the per-agent publisher lease (`client.publisherLease()`, store schema version 3 with the `publisher_lease` table) and bounds staged pairing messages: one still unsent after 24 h is marked not delivered, and one that keeps failing no longer blocks newer ones (`outbox_staged`).
- Updated dependencies [0baa0a5]
- Updated dependencies [c887320]
- Updated dependencies [f805b00]
- Updated dependencies [7121fa2]
- Updated dependencies [2172526]
- Updated dependencies [9c27388]
- Updated dependencies [32b70f5]
- Updated dependencies [cb7c956]
- Updated dependencies [fecd9a3]
- Updated dependencies [4287032]
- Updated dependencies [1feb21c]
- Updated dependencies [2d2e13f]
- Updated dependencies [39b1d8c]
- Updated dependencies [714f2ff]
- Updated dependencies [d440819]
- Updated dependencies [1548d6c]
- Updated dependencies [e46e352]
- Updated dependencies [7355a84]
- Updated dependencies [8efcc8e]
- Updated dependencies [2b46ba4]
- Updated dependencies [716365b]
- Updated dependencies [ebc37c1]
- Updated dependencies [d25bcbf]
- Updated dependencies [6963164]
- Updated dependencies [3e86521]
- Updated dependencies [f17fbf4]
- Updated dependencies [ab59425]
- Updated dependencies [af1ce64]
- Updated dependencies [66e997c]
- Updated dependencies [05fc15a]
- Updated dependencies [2e25c52]
- Updated dependencies [df0dc36]
- Updated dependencies [e1f2ba0]
- Updated dependencies [a96e852]
- Updated dependencies [e02996f]
- Updated dependencies [0cc4ff3]
- Updated dependencies [a1465a6]
- Updated dependencies [d9e2711]
  - @agentlink/crypto@0.1.0
  - @agentlink/core@0.1.0
  - @agentlink/transport-nostr@0.1.0
