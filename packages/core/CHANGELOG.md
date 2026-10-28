# @4thtech-io/core

## 0.4.2

### Patch Changes

- @4thtech-io/chain@0.4.2
  - @4thtech-io/crypto@0.4.2
  - @4thtech-io/log@0.4.2
  - @4thtech-io/storage@0.4.2
  - @4thtech-io/transport-nostr@0.4.2
  - @4thtech-io/types@0.4.2

## 0.4.1

### Patch Changes

- @4thtech-io/chain@0.4.1
  - @4thtech-io/crypto@0.4.1
  - @4thtech-io/log@0.4.1
  - @4thtech-io/storage@0.4.1
  - @4thtech-io/transport-nostr@0.4.1
  - @4thtech-io/types@0.4.1

## 0.4.0

### Minor Changes

- 662785b: M1-PAY-CONFIRM-a: confirming paid actions with the computer's own verification (04 §2.5.3, D-132). Core builds the confirmation statement and the challenge from stored data (`buildPayConfirmFlow`, `payConfirmChallenge`, `spendingChanges`) and refuses a paid item in `approval.decideBatch` (`paid_item_in_batch`). The local approval server adds `POST /api/ui/pay-confirm/begin` and `/finish`: user verification required, single use, bound to the page session, 120 s; the passkey's own signature is verified with the credential key kept at registration (crypto `verifyWebauthnSignature`, ES256 and EdDSA); the backup code keeps the three-tries rule. Approving a paid proof or changing a spending limit through an ordinary owner route now answers `confirm_required`; `agentlink approve` with no ID lists a paid request but sends it to `approve <id>` on its own.
- 64dab44: MSG-FILES-IO-a: read-only `MessagesView` (`client.messages`: conversations, and one contact's Inbox or Sent) and `FilesIoView` (`client.filesIo`: received and sent files) for the local app. Store only, decrypted on this computer, never a read mark for the AI; every item is built from an allowlist with no URL, file key or sealed value.
- a6846b5: MSG-FILES-IO-h: Show in Finder for a saved received file in the local app ("Show in folder" on Windows and Linux), with no Touch ID (D-134). The page sends only the item's ID; the local server reads the saved name from the store (core `filesIo.savedName`), opens the file once inside the Inbox folder without following a link, checks it, and asks the OS file manager to show it (no shell). New route kind `presence: 'reveal'` for `POST /api/ui/files/received/reveal` only. The Received and Sent tabs now read the real file lists: other people's file names sit in the untrusted-content box, a malformed item is skipped instead of hiding the list, and a file that was not delivered says so.

### Patch Changes

- f4d0c03: When your AI fetches a received file, the local store now remembers the name it was saved under in your Inbox folder, encrypted like the file's other details (MSG-FILES-IO-b), so the local app can show which received files are saved. Store schema version 6 adds `files.saved_name`; the SQLite store migrates automatically and existing files read "not saved yet". Migrations are forward-only: once a store is at version 6, an older AgentLink refuses to open it (`store_schema_newer` / `store_too_new`), so you cannot roll the package back after upgrading.
- c5425de: The local app's server can now list the files you received and sent (MSG-FILES-IO-d): two read-only routes, `GET /api/ui/files/received` and `GET /api/ui/files/sent`, for the owner's browser session only. Each item shows who, when, the file name, size and state; a received file you saved shows only the single name it was saved under. No file key, link, storage location, hash or folder path is ever returned, nothing is written, and no AI tool changes. Core's `client.filesIo` now reads that saved name; a saved name that cannot be read shows that one file without it instead of hiding the list.
- Updated dependencies [662785b]
  - @4thtech-io/crypto@0.4.0
  - @4thtech-io/chain@0.4.0
  - @4thtech-io/storage@0.4.0
  - @4thtech-io/transport-nostr@0.4.0
  - @4thtech-io/log@0.4.0
  - @4thtech-io/types@0.4.0

## 0.3.0

### Minor Changes

- 639f174: The local web app's Proofs and credits page (M1-11c-a4): two read routes, `GET /api/ui/proofs` (your proofs, newest first, paged) and `GET /api/ui/proofs/credits` (proofs left and the dollar balance), and the page itself. The read-only client view that handlers get now also has `proofs.list` and `proofs.creditsBalance`. No network, token, address or ID leaves the server for this page; Add credits stays hidden until the pay page is live. Core exports `PROOF_PRICE_USD_MICROS`, the price of one proof from the chain package's fee schedule, and the credits route returns it formatted. The page routes share fixed answers: 409 `not_set_up`, 400 `invalid_query`, 503 `unavailable`.
- b3b8782: Add credits by QR on the Gnosis test network, and Withdraw credits, in the local UI (M1-11c-a4c, D-122, D-123). New owner actions `credits.deposit` and `credits.withdraw` (strict params, 600 s lifetime). Core adds a read of where funds can be sent (`proofs.receiveOptions()`), `proofs.addReceivedFunds(signed)` and `proofs.withdrawCredits(signed)`: the agent's own `deposit` or `withdraw` in direct mode, signed by its KeyStore, only after a fresh owner-signed action, keeping a 0.01 xDAI gas reserve, Chiado only, never a mainnet; a withdrawal goes to the agent's own account only. The local UI server adds `GET /api/ui/proofs/top-up` and the presence-gated `POST /api/ui/proofs/top-up` and `POST /api/ui/proofs/withdraw`. The CLI wires direct mode per testnet.

### Patch Changes

- f1cff39: M2-3a: the SQLite DDL of the logical store schema moved unchanged from `@4thtech-io/node` (`sqlite-schema.ts`) to `@4thtech-io/core` (`store/sql-schema.ts`, exported as `createSqlSchemaStatements` and its helpers), so the cloud agent's Durable Object store runs exactly the Node store's statements. The Node store re-exports them under their earlier names; its pinned statement digests are unchanged. No behaviour change.
- Updated dependencies [b3b8782]
  - @4thtech-io/types@0.3.0
  - @4thtech-io/chain@0.3.0
  - @4thtech-io/transport-nostr@0.3.0
  - @4thtech-io/crypto@0.3.0
  - @4thtech-io/log@0.3.0
  - @4thtech-io/storage@0.3.0

## 0.2.0

### Minor Changes

- b5c51e6: Read-only accessors for the local UI (M1-11r-a): `identity.fingerprints()`, `identity.agentAddress()` and `identity.relays()`; `client.files.resolvedFolders()`; `proofs.list({cursor, limit})`, `proofs.creditsBalance()` and `proofs.requestFaucet(chainId)` (allowlisted testnets only, through the new optional `ProofsPlatform.faucet` port); and `client.activity.list({cursor, limit})`, a newest-first feed of decided approvals, proofs, blocks and the rules in force. Public values only; no new storage. `ProofKit` now also picks `readCreditsAcrossChains` and `isFaucetChain` (pass `@4thtech-io/chain` itself, as before).
- 27437fc: Owner-operation prepare helpers for the local UI (M1-11r-b, D-118). `OwnerActions.preparePolicyEdit(patch, options)` builds the unsigned `policy.set` body: the complete 06 §3 document from the verified policy (or the defaults) with a typed patch merged over it, at the version above the KeyStore mark and the stored row; it refuses a strict-schema violation, a stale base version and any edit while the policy fails closed, and signs delivery receipts on from an older default as `false` unless the owner keeps them (D-109). `prepareContactCheck`, `prepareContactRename` and `prepareContactRemove` build the unsigned `contact.*` bodies. `buildOwnerActionBody` is the pure, byte-exact builder (JCS; reproduces the owner-action signing vectors). Nothing here signs: the server signs after presence. `ContactBook.currentPairingDigest` recomputes the pairing digest for `contact.check`. Types: `policyPatchSchema` and `PolicyPatch`.
- be16e36: Storage page reads for the local UI (M1-11r-c): `client.files.dropUsage()` (this agent's drop bytes in the rolling 7 days against the weekly quota, with a within, near or reached level and the reset time) and `client.ownStorage.status()` with `ownStorage.recordTest({ok, code})` (none, ready or broken, the provider and the last test result). New optional `DropConfig.weeklyQuotaBytes` for a staging or self-hosted drop. Numbers, fixed codes and the provider only: never an endpoint, bucket, credential, locator or URL.
- 8928493: The activity feed (`client.activity.list`) now lists messages and files, sent and received (one entry per message, kind `message` or `file`, with each file's sanitized name, size and whether it was removed), and requests from unknown senders by their sender code. Proof, message, file and blocked-contact entries carry the contact's display name (an owner alias or the restricted name with its identity label, never the raw declared name), and proof, message and file entries carry their cost: free, charged, reserved, not charged or unknown. No payload, URL, file key or locator ever reaches an entry.
- cf800d0: With delete after receipt turned on, your agent deletes a sent file from storage once the contact's delivery receipt is on record, also after a key change (M1-1g-h).
- 70e362b: You can ask a contact to confirm delivery of a message with proof, and when a contact asks you, your agent confirms only after you say yes (M1-33d, D-109).
- ca60f25: When a message network server returns only part of a busy second, your agent now says that some messages may be missing from that check and that it looks again on the next one. Core sync results carry this as an `incomplete` count only (M1-5g).
- 31957b7: When a contact's owner revokes that agent, your agent now voids every approval still waiting for the owner and every unfinished part of an agreement with that contact, in the same step that records the revocation, and reports what it stopped. Delivery acknowledgements are queued for the delivery pass instead of sent during an inbox sync, a status check no longer counts a contact's acknowledgements as unread once their type is known, and a key store that cannot list the agent's keys no longer makes the whole sync fail (M1-7h-b).
- 3a08533: Offers and acceptances can now carry proof (M1-9d-3): a firm offer (`agentlink_propose_terms` with `notarize`) and a recorded acceptance (`agentlink_respond_to_terms` `accept` with `notarize`) each need one owner approval that covers the terms and the proof fee, so a proof of agreement can be made and exported through the tools.
- 6055f38: Counter-offers can now carry proof (M1-9d-5): `agentlink_respond_to_terms` `counter` with `notarize` is a firm offer under one owner approval that covers the new terms and the proof fee, as `agentlink_propose_terms` with `notarize`.
- 1d10f83: Owner-signed own storage and recovery-kit export (M1-9i-a, D-115). `@4thtech-io/types` adds the `storage.set`, `storage.remove` and `backup.export` owner actions with strict params (L(op) = 600 s), `STORAGE_PROVIDERS`, `BACKUP_KIT_CONTENTS` and `isCanonicalS3Endpoint`. `@4thtech-io/core` applies them (nonce row and the one `own_storage` row in one transaction, then the KeyStore `storage-mark`), adds `ownStorage.load()` (`none`, `ready` or `broken`, re-verified on every load, never by expiry), the `OwnStorageKeys` interface and the `storage-mark` codec, and the `brokenOwnStorageAdapter` stub: a broken own storage makes a stored file send `needs_setup` `storage_broken`, never the drop. Store schema version 5 adds `own_storage`; `@4thtech-io/node` migrates SQLite stores to it.

### Patch Changes

- 0e5fef3: Delete after receipt now applies only to files sent while it was on: turning it on later never deletes files sent earlier, and files sent before this update are kept until they expire (M1-1g-i).
- cb4a63a: Owner approvals, policies and revocations, envelopes, agent cards and proof packs are now checked from the exact text received: text that repeats a field name or spells one with an escape sequence is refused as malformed before the signature is checked (M1-1h-b, D-128). New in `@4thtech-io/crypto`: `parseReceivedJson`, `parseEnvelopeText` and the `plainMemberNames` option of `parseJson`.
- 52c8fe8: M1-33a (D-109): delivery receipts are off by default. `@4thtech-io/types`: the 06 §3 default `receipts.autoDelivered` is `false`; a `ContactRule` may carry `receipts: {autoDelivered}` (strict) with or without `proofs`, and needs at least one of the two. `@4thtech-io/core`: an automatic DELIVERED receipt uses the record signer's contact rule when that contact is paired and not blocked or revoked, else the global value; under failing rules none is signed. OPENED, ACCEPTED and REJECTED are unchanged. `@4thtech-io/core` also adds `receiptsOnFromOlderDefault` and `recordReceiptsKept` on `OwnerActions` and the `receiptsKept` client option (a `ReceiptsKeptMark`). `@4thtech-io/node`: the receipts-kept marker as the keychain item `<agentId>:receipts-kept`, on `AgentStore.receiptsKept`. `@4thtech-io/agentlink`: the rules review lists a contact's delivery-receipt rule; a policy signed earlier keeps its value until the owner next signs their rules, which then asks "Keep delivery receipts on?" and turns them off unless the owner types y (a yes is remembered); until then `agentlink doctor` shows the older-default line.
- bc8d9f3: Proofs (M1-33c, D-109): a Record's `parentRecordId` is zero by default and only ever names a record the chain shows this agent signed; anything else is refused with `PARENT_NOT_OWN` and nothing is signed or charged. A received Record that names another signer's record as its parent is dropped and logged (`proof_parent_mismatch`) and gets no receipt; flagging the contact is pending M1-7g-c.
- 16f692e: Receipt request follow-ups (M1-33d-b, D-109): `notarize` with `requestReceipt` on an envelope that already had a proof without a request now returns `receiptRequestNotAdded: true`, and `agentlink_notarize` and `agentlink_send` say so in the result and the summary. Two concurrent `acknowledge {type: "delivered"}` calls for one record sign one DELIVERED receipt. An inbox page reads the receipt-request flag of all its items in one read instead of one transaction per item.
- 320bc9e: Receipts covered by the sender's proof fee (M1-34-b, D-114). The submitter accepts up to 3 receipts for a record the Notary stores (its NOTARIZE fee was charged), whatever the recipient holds: one `getRecord` read per record before simulation; a receipt for an unknown record is `failed` with `RecordNotFound`, a new type over the cap (on-chain plus in flight) with `receipt_limit`, and ACCEPTED against REJECTED in flight with `ConflictingReceipt`. The chain port gains `recordReceipts` and `MAX_RECEIPTS_PER_RECORD`. `createProofSubmitter` never sends a receipt in direct mode unless `directReceipts: true`, so the recipient's own account never pays for it unasked; a receipt no submitter takes is `pending`. `ProofSubmitter.acknowledge` takes an optional per-call `waitMs`. The core posts queued receipts (`postQueuedReceipts`, at most 5 per pass, least recently tried first, 2 s wait each) after each sync pass's new envelopes, the same signed bytes until they land; a receipt the chain refuses for good (`RecordNotFound`, `InvalidSignature`, `NotRecipient`) becomes `receipt_failed` and is not retried.
- 19c8626: A receipt that the client's chain reads answer `RecordNotFound` for is posted again once, with the same signed bytes, after a fixed 3 s (`RECEIPT_NOT_FOUND_RETRIES`, `RECEIPT_NOT_FOUND_RETRY_MS`) before it becomes `receipt_failed` (M1-34-c), so an RPC that lags behind the record's block does not fail the receipt for good. `ProofsPlatform` takes an optional `sleep` for that delay.
- 068d989: The outbox pass now returns the transport's notices: which rows cannot reach 2 usable relays, with a fixed reason.
- f8c4440: Retention at expiry and crypto-shredding (M1-7f-2; 04 §4, D-98). At ingest the core moves each inbound `fileKey` into a sealed receiver `files` row and stores the payload with a placeholder key; `fetchFile` reads the key from that row (a payload stored earlier still uses its own key). New `deleteExpiredFiles()`, also run by `syncInbox`: at `expiresAt` the sender deletes the stored object (the drop with a DELETE signed at the upload epoch) and its `files` row, and the receiver deletes its row. The delete-on-receipt pass now deletes the row instead of marking `deleted_at`.
- 0f13f71: refresh-link (M1-7f-3; 04 §4, 07 §5.2). New `requestFileLink({envelopeId, fileIndex})` sends a `request` envelope `{kind: "refresh-link", envelopeId, fileIndex}` to the contact that sent a stored file; after each processing pass (`syncInbox`, the live loop) the sender's core answers from its own storage with a `file` envelope carrying the file's entry with a fresh presigned link that never outlives the file's `expiresAt`, and the recipient's core moves that link into its receiver row, so `fetchFile` works again. Only the contact the file was sent to gets an answer; the drop and inline files are not refreshable. `fetchFile` now uses the receiver row's link. The `refresh-link` request body in `@4thtech-io/types` names the file by `fileIndex` instead of `ciphertextSha256` (a request is shown in the inbox, 06 §2.1).
- 8621ff4: Proofs (M1-7g-c, 04 §3.4): a received `proof` body that does not match the on-chain record (`proof_mismatch`, or `proof_parent_mismatch` for another signer's parent) now flags the contact: the `proof` envelope is stored as refused with that fixed code, and `syncInbox` and the live subscription report it as a flagged refusal. `ProofService.processInbound` returns `{signed, reports}` (`ProofInboundResult`) instead of a number. One contact holds at most `PROOF_PENDING_PER_CONTACT` (32) of the 256 bodies pending a chain read.
- 4be1e27: Proofs and logging (M1-7g-d): the logger takes an allowlist of fixed codes (`createLogger({ codes })`, `logger.withCodes()`), so a top-level `code` field keeps only listed codes and every other value stays redacted; the proof flow lists its own codes (`PROOF_LOG_CODES`). An approved `confirm` now signs its `ACCEPTED` receipt on the other side's ACCEPT record, once, under the same approval. A contact can hold at most 32 of the 256 `proof` envelopes that wait for their message (`PROOF_AWAITING_PER_CONTACT`); beyond that the envelope is dropped as `proof_unchecked`.
- e7ac634: M1-7g-f: `respondToTerms` reports the receipt status after the deferred receipt run (`recorded`, `submitted` or `waiting_for_record`); a waiting `proof` envelope whose envelope was refused releases its pool slot.
- 821ac87: Accepting an invite now checks that the contact being staged is the one the invite names (the card verified in Accept step 1 and shown for approval). Any mismatch is refused as an invalid invite before anything is written.
- 8565521: Accepting an invite now also checks that the contact being staged has the owner shown for approval and is exactly the card the invite carried (its owner fingerprint and its card hash). A card with the right contact id but another owner, keys or epoch is refused as an invalid invite before anything is written.
- c6546b9: M3-4b-t-T4-a: an internal core step for the owner-approved gasless top-up (Base Sepolia USDC into the agent's own credits). It requires an owner-signed approval that the owner-action verifier vouches for, records it once before signing, allows at most 5 approved top-ups per agent per hour, $5 to $50, signs with the agent key only and confirms the credit on chain. Not exported and not reachable from any MCP tool; still off while `GASLESS_TOPUP_ENABLED` is false. `ProofsPlatform` gains an optional `depositAuth` port and `ProofKit` the gasless builder functions.
- Updated dependencies [d70bf37]
- Updated dependencies [7a67b65]
- Updated dependencies [5261347]
- Updated dependencies [9c56860]
- Updated dependencies [e51e49e]
- Updated dependencies [113cd50]
- Updated dependencies [b155084]
- Updated dependencies [52fd677]
- Updated dependencies [27437fc]
- Updated dependencies [cb4a63a]
- Updated dependencies [52c8fe8]
- Updated dependencies [de8696b]
- Updated dependencies [e7aeadf]
- Updated dependencies [70e362b]
- Updated dependencies [320bc9e]
- Updated dependencies [5864ac4]
- Updated dependencies [7b053cc]
- Updated dependencies [3a3837b]
- Updated dependencies [e2a5052]
- Updated dependencies [9676c15]
- Updated dependencies [5c19ee0]
- Updated dependencies [1cd25e4]
- Updated dependencies [068d989]
- Updated dependencies [ec598ee]
- Updated dependencies [d311d76]
- Updated dependencies [82a60e6]
- Updated dependencies [607dc70]
- Updated dependencies [2286724]
- Updated dependencies [0f13f71]
- Updated dependencies [4be1e27]
- Updated dependencies [1d10f83]
- Updated dependencies [0ece43e]
- Updated dependencies [c6aa21f]
- Updated dependencies [529a0f6]
- Updated dependencies [62e8d42]
- Updated dependencies [9dbaa44]
- Updated dependencies [5ffb078]
- Updated dependencies [d48cc3f]
  - @4thtech-io/chain@0.2.0
  - @4thtech-io/log@0.2.0
  - @4thtech-io/types@0.2.0
  - @4thtech-io/crypto@0.2.0
  - @4thtech-io/transport-nostr@0.2.0
  - @4thtech-io/storage@0.2.0

## 0.1.2

### Patch Changes

- b63fd4e: Terms: one approval reports `ok` to one request only. A later or concurrent call with the same `approvalId` under another request returns `APPROVAL_USED` with the original envelope, also while that accept is still waiting for relay acknowledgements; a repeat of the same `clientRequestId` still returns its original result (04 §3.4.2).
- 84bda36: M1-1g-g: a file shared through the encrypted drop stays deletable after a key rotation. The drop adapter records the drop key epoch of each upload and signs its delete with that epoch's key; the core keeps the epoch in the sealed file record.
- 2e6b70e: M1-4d-d-b: the agent card's proof of possession (04 §2.9, D-102). `TAGS.cardPop` (`agentlink/card-pop/v1`), `verifyCardPop`, `verifyCardPossession` and `cardPopSnapshot` are in the crypto main entry; the raw-key `signCardPop` is in the restricted `@4thtech-io/crypto/keystore` entry. `KeyStore.signCardPop(card)` signs only the store's own card at its current key epoch and refuses anything else with one fixed error; implemented by `MemoryKeyStore` and the keychain KeyStore (and its facade). The `handshake` and `handshake-ack` bodies take an optional `cardPop`, and `card-update` optional `cardAgentSig` and `cardPop`, together or not at all. The core makes `cardPop` with every own card (init, so also `owner add-agent`, and rotation once the KeyStore is at the new epoch; a card stored before this change gets one on first use), sends it in `handshake` and `handshake-ack`, verifies a received pair in `handshake`, `handshake-ack` and `card-update` (a present signature that does not verify drops the whole body), and stores a contact's verified pair. `proofSigner(from)` returns the signer block with the pair for the upcoming `exportProofPack` (M1-7g); the core does not yet send `card-update` itself. `verifyProofPack` uses the crypto check instead of its own composition (no behaviour change).
- bdf5da6: M1-4d-f: the core sends `card-update` itself (04 §2.6, §2.9, §3.4.1; D-102). `client.sendCardUpdates()` (also run by `syncInbox`) sends the current card with `cardSig`, `cardAgentSig` and `cardPop` to every active, paired contact that does not hold it yet and that the owner's `contacts.allowed` permits (D-106; none while the policy fails closed); it is idempotent and resends one the outbox gave up on. The agent keeps its own earlier cards, one per key epoch, in the sealed identity card (no schema change), so `proofSigner(from)` returns the card of the envelope's key epoch for the upcoming `exportProofPack` (M1-7g); a future epoch or an unfinished rotation never gets one. A rotation signs the outgoing card's `cardPop` when it still lacks one. The late `cardPop` write checks its compare-and-set: a lost race is read again, and a race that keeps losing is reported (`key_epoch_mismatch`).
- 19e234d: M1-7f: files in the core. `sendMessage({files})` checks every file (size cap, realpath strictly inside an allowed folder, storage) and the D-85 inline plan, refusing `PAYLOAD_TOO_LARGE` before any read or upload, then encrypts each file with a fresh key (inline, own storage, or the encrypted drop signed through `KeyStore.signDropRequest`) and stores sealed `files` rows; uploads are deleted on any later failure. `fetchFile({envelopeId, fileIndex})` applies the receive cap, the expiry and the URL check, verifies inline ciphertext before decryption and saves through a quarantine file (D-84) under a sanitised, never-overwriting name. `isInsideFolder` is one helper with an explicit `self` rule, used by the path guard and the policy engine. New: the `files` client option (`FilesPlatform`), `withNameSuffix`, `planPacking` and `measurePayload`.
  
  `@4thtech-io/storage`: the response helpers move from the S3 session into `http.ts`, so the drop adapter no longer imports the S3 signer (aws4fetch) and a bundle that uses only the drop does not load it. No behaviour change.
- 49eb7be: M1-7g-b (D-107): recipient-side proof-pack export. `@4thtech-io/types`: the strict `proof` body schema accepts the signed `record` (05 §3.1 JSON form) and its `signature` (1 to 4 096 bytes), present together or not at all. `@4thtech-io/core`: every `proof` body the core sends carries the signed Record and signature; the recipient runs the 04 §3.4 receive checks 1–5 before storing them (a mismatch drops the whole body, `proof_mismatch`), keeps a body whose chain read failed pending and checks it again at later syncs (at most 256 bodies, 7 days, then `proof_unchecked`), and `exportProofPack` builds the recipient's own pack (recipient and salt only with `includeRecipient`; `RECORD_UNAVAILABLE` for an older sender's body). `ProofKit` now also takes `computeRecordId` and `verifyProofPack` from `@4thtech-io/chain`.
- c6eb603: M1-7g: notarize, receipts and the proof-pack export in the core. `notarize` records a sent envelope (kind from the payload, automatic chain selection, policy and daily budget, approvals) and delivers the salt in a `proof` envelope; the recipient checks the record on-chain before any receipt, signs DELIVERED per policy and the deferred ACCEPTED of an approved accept; `acknowledge`, `getProof` and `proofs.exportProofPack` (key disclosure only with an owner approval). New client option `proofs`.
- Updated dependencies [8c9cdd1]
- Updated dependencies [1753640]
- Updated dependencies [75737c8]
- Updated dependencies [dd9650b]
- Updated dependencies [4d7d3e4]
- Updated dependencies [84bda36]
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
- Updated dependencies [942b276]
- Updated dependencies [19e234d]
- Updated dependencies [49eb7be]
  - @4thtech-io/chain@0.1.2
  - @4thtech-io/crypto@0.1.2
  - @4thtech-io/storage@0.1.2
  - @4thtech-io/types@0.1.2
  - @4thtech-io/transport-nostr@0.1.2
  - @4thtech-io/log@0.1.2

## 0.1.1

### Patch Changes

- 088b5fd: Live relay subscriptions (M1-9s): `Transport.subscribe` and `AgentLinkClient.subscribeInbox` in the core; the MCP server's background loop receives new messages and handshakes as they reach a relay, with a 5-minute fallback catch-up, and closes the subscription on lease loss and on shutdown.
- 053a2cb: M1-15: SSRF-safe download (DNS-pinned, at most 2 re-checked redirects, byte cap, deadline), allowed-folder path guard with realpath on both sides, and a download file-name sanitiser. Not wired into any tool yet.
- 58df129: M1-9za: owner commands `contacts rename` and `contacts remove`, signed as the new owner actions `contact.rename` and `contact.remove`; `contacts` lists each contact's ID.
- Updated dependencies [088b5fd]
- Updated dependencies [4dcc340]
- Updated dependencies [af00aaa]
- Updated dependencies [b26ef46]
- Updated dependencies [2a6716d]
- Updated dependencies [c4c1f86]
- Updated dependencies [9f3ad1b]
- Updated dependencies [379d2d4]
- Updated dependencies [e768cd1]
- Updated dependencies [58df129]
  - @agentlink/transport-nostr@0.1.1
  - @agentlink/crypto@0.1.1
  - @agentlink/storage@0.1.1
  - @agentlink/types@0.1.1
  - @agentlink/chain@0.1.1
  - @agentlink/log@0.1.1

## 0.1.0

### Minor Changes

- fecd9a3: Add owner-only key rotation. `@agentlink/crypto` adds the `KeyEpochControl` interface, a management surface kept apart from the agent's `KeyStore`, so the agent path cannot move the key epoch. `previewEpoch(n + 1)` returns the next epoch's public keys without advancing; until the advance, signing and decryption at that epoch stay unavailable. `advanceEpoch(expected, ownerSession)` is a compare-and-set: it needs a live owner session, and it fails with the new `epoch_conflict` code, changing nothing, unless the store is at `expected`. Older epochs still decrypt. The control is a separate object that the agent KeyStore cannot reach, and it accepts only sessions its paired owner store issued; the test double makes it with `MemoryOwnerKeyStore.epochControl(keyStore)`. In `@agentlink/core`, `identity.rotate` takes the control from the owner flow. It signs the next card, stores it as pending (new `identity.pending_card_json` column), advances the KeyStore, and then commits the new epoch. When the client opens, an owner-signed pending card for exactly the KeyStore's keys finishes an interrupted rotation, unless it has expired or its advance failed. Without one, the agent refuses to send until the owner rotates again.
- 2d2e13f: Add the commitments policy to the core (M1-20, D-31, D-55). `evaluateCommitment(policy, facts)` is the pure `commitments` rule for one commitment scope and its stored terms: `deny` blocks, `allow` allows, the default `approval` asks the owner, and a fail-closed policy always asks. Auto-accept applies only to an `accept` or `confirm` from an allowlisted contact whose terms have a price in the USD set (USD, USDC, USDT, XDAI), in the owner's direction and within `autoAcceptMaxUSD` (buy) or from `autoAcceptMinUSD` (sell, off by default); never to a `REJECTED` receipt, a firm offer or terms without a price. A late accept of one of this agent's own superseded versions (`supersededByOwnNewer`) always asks, even under `allow`. A scope and terms that do not bind each other (schema, parties, version or `termsHash`) are `void` with `APPROVAL_VOID` under every policy, and no request is created. An `allow` returns a policy grant with the verified policy's hash; `recheckCommitmentGrant` asks the owner once the policy changed. Also `checkCommitmentBinding`, `commitmentParts`, `commitmentVoidedByPolicy`, `policyDocumentHash` and `isCommitmentAction`. Breaking: the `commitment` policy action now carries `facts`. A batch approval now also refuses an `accepted`/`rejected` acknowledgement, which is a commitment without a scope (D-68).
- 714f2ff: Fresh sessions can find open offers and finish approved actions (M1-22). Core adds `TermsService.openOffers()` (received offers still waiting for an answer, read from the store: newest open version, from an active contact, not accepted, not rejected by this agent, not expired), `ApprovalService.resumeOf(approvalId)` (the tool and only its structured, re-verified args while the agent still has something to run) and an `envelopeIds` filter on the inbox page. `agentlink_status` adds `openOffers` and `offers` (counts by contact) and a summary line; `agentlink_inbox` takes `openOffers: true` to list them, read ones included; `agentlink_get_approval` adds `action` (tool, and for a terms accept or reject the `envelopeId` and `decision`) and, once approved, a `nextStep` that says how to finish.
- 1548d6c: Add the terms flow and one approval per agreement (M1-32, D-55). `client.proposeTerms` and `client.respondToTerms` (`accept`, `reject`, `counter`) fill the chain fields from the agent's own store and copy the stored terms into answers. The 04 §3.4 negotiation chain runs on receive (new inbound reason `terms_refused`) and is rebuilt from the stored envelopes. An `accept` builds one `CommitmentScope`, is decided by `evaluateCommitment` (owner request or policy grant; nothing is sent or stored on deny), and runs each part at most once under an atomic claim, with void rules 1–6 checked before each part. `client.terms` exposes the commitment card data, the negotiations, `deferredReceipt` and `claimReceiptPartTx` (for M1-7g), and `expireDue`. `ApprovalService.request` takes an optional `commitment` (scope key and parts). `notarize` returns `NOTARIZE_UNAVAILABLE` until the proof flow lands.
- 716365b: Add the core skeleton: `AgentLinkClient.create` over a KeyStore, a Store, a store cipher and an approval channel. The `Store` interface covers every table of the local store schema (07 §3, with the G-9 delivery, idempotency, owner-authority and budget tables and the staged `pairings`). Its transactions are synchronous and all-or-nothing, updates return counts for compare-and-set, and the store enforces the schema rules itself. An in-memory Store is included for tests. The `ApprovalChannel` interface only delivers requests: nothing it returns approves anything without an owner signature. Identity issues the agent card signed by the owner and endorsed by the agent key, records the agent ID with a random storage prefix, and rotates to the next key epoch with a new card. Until a rotation is complete it refuses to send. Contacts are keyed by agent ID. A pairing is staged from a verified card and committed only when its handshake completes. Contacts follow the re-pair, revocation and key rules and take card updates. A contact can be blocked, or removed as a tombstone, and either way its later envelopes are dropped. Cards, names and relays are stored in columns marked for encryption at rest, sealed through a store-cipher interface; the real cipher (AES-256-GCM under the store key) lands with M1-8b, so nothing is encrypted at rest yet. Display names are marked self-declared.
- ebc37c1: Require the sender's own owner entry on receive (M1-7b-b, G-51, D-71 (4); 04 §3.1.1 step 8, §3.2). When the core holds the sender's card (a contact's current card, the card a `card-update` carries once it passes §3.4.1, or the body card of a pairing message), an envelope whose recipients lack that card's `ownerEnc` `kid` is refused with the new fixed reason `sender_owner_entry_missing`: stored as refused without its ciphertext or payload, and the contact flagged; a pairing message from a key that is not a contact's is refused without flagging anyone. The check is a presence check on the `kid` (no extra content-key opening) and runs after the own-owner rule, which still reports first. When both agents have the same owner the one owner entry meets both rules; senders whose card is not held and owner-authored types are unchanged. After a `card-update` is applied, the held envelopes from that card's agent key now also run again at once, including any held under another contact owner's `kid`.
- d25bcbf: Add envelopes to the core (`client.envelopes`). Sending builds the envelope after `assertCanSend`: the payload passes its strict schema, the core picks the recipients itself (the contact's agent and owner, the sender's owner and agent, one entry per distinct key; only the agent and its owner on the owner channel), wraps one content key to each of them, signs the envelope with the agent key, checks the 24 KB limit and stores it as sent, with the decrypted payload only in an encrypted column. Receiving checks the structure and the signature and stores the envelope as received with its seen rows. Processing then decrypts it with exactly one key opening and checks the key commitment, the payload, the sender's role (contact, earlier key, unknown sender, owner keys), the owner's entry and the other entries it can recompute, the clock and the envelope ID. Card updates are processed first; an envelope from a contact's new key that arrives before its card update is held for up to 48 hours (at most 100 per owner key) and checked again once the update is applied. Refusals that show a sender signed entries carrying different keys flag the contact. Errors and reports never contain inbound content.
- 6963164: Add `contact.check` verify and store (M1-7c-b, 04 §2.5.1, §3.6.1, G-28). `contacts.applyContactCheck(signed)` applies an owner-signed `contact.check` only when it is in its exact strict form, bound to this agent, signed by the owner key in the agent's own card, fresh (`issuedAt` at most 300 s ahead, not expired, lifetime at most 24 h), names a contact with a completed pairing, and its `pairingDigest` equals the digest recomputed from that pairing's stored signed `handshake` and `handshake-ack`. The nonce check, the nonce record (`owner_action_nonces`) and the write of the signed object to `contacts.safety_check` are one store transaction, which also checks that the contact still points at the same pair. Anything else returns `{status: 'refused', reason}` with a fixed code and writes nothing. `ContactView.safetyCodeChecked` (and the `safety-code-checked` label) is now derived on every read by re-verifying the stored object against a fresh recomputation; the `safety_code_checked` column is never read, and a completed re-pair clears it. The pure checks (`checkContactCheckObject`, `verifyContactCheck`, `storedContactCheckHolds`) are exported. `pairing.ownerSafetyCode` now shares the stored-pair recomputation with the contact view.
- 3e86521: Add invites and pairing (M1-7c, 04 §3.6, §3.6.1). `client.pairing.createInvite` makes a single-use invite (1 to 7 days, default 7) and returns its link, the owner fingerprint and the expiry; the store keeps only the encrypted proof key and nonce, never the invite secret. `acceptInvite` decodes the link with the one invite codec (`decodeInviteLink` / `encodeInviteLink`: raw DEFLATE, D-69, with the input bounded before parsing, inflation capped at 16 384 bytes in 1 KiB slices, an exact end of stream and strict UTF-8, I-JSON and schema checks), checks both card signatures, the name and relays and the expiry, and returns `pending_approval` unless the `contacts.acceptInvites` decision allows it; then it stages the pairing and stores the signed handshake. Inbound `handshake` and `handshake-ack` envelopes are handled in `envelopes.processReceived`: the inviter checks the proof, the sender key, the cards, the invite card hash and the commitment, and completes with its ack; the invitee completes only when the ack matches its handshake, the invite card and relays and opens the commitment. A second valid answer to a used invite is refused (`invite_used`). `contacts.completePairing` now binds its evidence to the pairing (the pairing ID is the handshake envelope ID, and the pair must verify as a safety-code transcript), and crossed pairings converge by the later handshake. `pairing.ownerSafetyCode` recomputes the code from the signed messages for owner surfaces only; `recomputeSafetyCode` and `verifyPairingTranscript` are exported. `restrictName` and `renderContactName` implement the contact-name rule, and `ContactView` gains `display`. `safetyCodeChecked` is now always false until `contact.check` verification lands (M1-7c-b).
- f17fbf4: Route `contact.check` through the owner-action module (M1-7d with M1-7c-b, IR-M1-7c-b-1 F02, F03). `client.ownerActions.apply` now applies a `contact.check` through `contacts.applyContactCheck` instead of refusing it with `unsupported_op`: the same object checks in the 04 §2.5.1 order, the nonce before the op's rule, and the same fixed refusal codes, which `OwnerActionRefusal` now includes (`contact_unknown`, `pairing_unavailable`). A revoked own agent refuses a `contact.check` with `identity_revoked`, on both paths. The `OwnerActions` constructor takes the `ContactBook` (`new OwnerActions(ctx, identity, contacts, mark?)`). One shared read of the own stored card replaces the copies in `IdentityService` and `ContactBook`. No behaviour change for the other ops.
- ab59425: Add owner-signed actions and the policy engine to the core. `client.ownerActions.apply` verifies a `SignedOwnerAction` (strict JSON text and schema, the agent and owner binding against the own card, the owner-action signature, the clock skew, expiry and maximum lifetime per op, the nonce) and applies `approval.decide`, `approval.decideBatch`, `approval.cancel` and `policy.set` with the nonce check, its record and the effect in one store transaction, so a replay or a second delivery applies nothing. Decisions are checked against a digest recomputed from the stored request; a cancel of a pending request denies it; a batch applies whole or not at all, never includes a commitment, cannot outlive its earliest request, and burns its nonce when refused. `policy.set` must be above both the stored version and the policy-version mark, which a new `policyMark` option supplies. `loadPolicy` re-verifies the stored policy on every load and fails closed (never the defaults) once a version was applied; `checkApproval` re-verifies a stored decision when its approval is used. The pure `evaluate(policy, action, context)` covers the contacts, envelope, commitment, key-disclosure and receipt rules for M1a. Applying `agent.revoke` and `contact.check` is not part of this change.
- af1ce64: Add the owner's answers to requests from unknown senders and refused-row retention to the core (M1-7e-2, D-72). `client.requests` gains `accept(requestId)` (flags that one request row readable; it still counts toward the limits, and no contact or pairing is written), `ignore(fromKey)` (now also removes the key's refusals), `ignoreAll()`, `block(requestId)` (adds the key to `blocked_keys` and removes its requests, refusals and held envelopes in one transaction), `unblock(fromKey)` (by key, never by the sender-chosen envelope ID) and `listBlocked()`; `list()` entries carry `acceptedAt`. Envelopes from a blocked key are dropped at the start of 04 §3.1.1 step 5, before any decryption, with the new fixed reason `sender_blocked`; a contact's card-update from a blocked new epoch key still applies and removes the block, and a pairing message from a blocked key is always dropped. Refusals from unknown keys stop counting 7 days after the local `refused_at` (or when `refused_at` is more than 300 s ahead) and are pruned at the start of each processing pass. `requestsFullTx` now takes `now`. The idempotency `begin` refuses a `clientRequestId` outside 1 to 256 UTF-8 bytes and a tool name outside the 06 §2.0 set with `idempotency_args_invalid`. Store schema version 2: `envelopes.refused_at`, `envelopes.request_accepted_at` and the `blocked_keys` table; the Node SQLite store migrates a version 1 file forward.
- 66e997c: Add `ApprovalService.read(approvalId)` and `ApprovalService.countPending()` in `@agentlink/core` (M1-7e-3): one approval's state for its own stored action, with the stored owner decision and cancel re-verified against the recomputed action digest before the status cache is read (`pending`, `approved`, `denied`, `cancelled`, `expired`, `used`, `void`, or `unknown` with `not_found` or `invalid` for a row that does not verify), and the number of approvals waiting for the owner. The result never carries the owner signature, the decision payload, the action or the summary, and reading never changes a row. `OwnerActions.readApproval` backs it. In `@agentlink/types`, a `pending_approval` result no longer requires `url` (06 §2.5: none in M1a), and `getApprovalResultSchema` accepts `used: true` on an `expired` approval.
- 05fc15a: Add approval requests, the requests-queue limits and `clientRequestId` idempotency to the core. `client.approvalService.request` stores a pending request bound to the action digest (strict per-tool action schema, checked summary, 24-hour TTL or the commitment scope's earlier expiry) and hands it to the approval channel; `authorize` and `use` let an approved ID run the identical action once, with the owner's decision re-verified, policy evaluated again and a compare-and-set to `void` in the effect transaction; `collect` applies a signed decision from the channel only through `ownerActions.apply`; `expireDue` marks lapsed requests. `feeContextFromQuote` builds an approval fee from one quote. Inbound requests from unknown senders are limited to 5 per sender key and 200 in total (refused envelopes from unknown keys count), counted in the transaction that stores them; `client.requests` lists, counts and ignores them, and `queueRefusals` gives the owner's aggregated count. `client.idempotency` implements 07 §3.3 (keyed request digest, execution lease, compare-and-set on every effect and on finish, `IDEMPOTENCY_KEY_REUSED`, stale `pending_approval` not replayed). `checkApproval` now reports `void` for a used approval. `StoreCipher` gains an optional `indexDigest`; without it idempotency fails closed.
- 2e25c52: Add `InboxService.page(query)` (`client.inbox.page`), the inbox page read of 06 §2.2: received messages, accepted requests (D-72, with the sender code and no name) and, with `includeSent`, our own sent messages, per contact or across all contacts, ordered by (`createdAt`, envelopeId bytes), with `limit` 1 to 100, `before`, `since`, `includeRead` and a caller byte bound. The returned unread inbound items are marked read in the transaction that commits the page. New client option `dropOrigins`; new error codes `inbox_query_invalid` and `inbox_busy`.
- df0dc36: Add inbox sync, delivery acknowledgements and the fetch-only catch-up to the core (M1-7h). `client.syncInbox({budgetMs})` reads the agent's own relays for its keys at every epoch through transport-nostr's sync (per-relay cursor with the 48 h look-back, dedup by gift-wrap ID), skips an envelope whose hash is already in the seen-set, so each envelope's signature is verified once, stores new envelopes, drops a contact's envelopes above `contacts.rateLimitPerContactPerHour` (counted once, per contact, in a sliding hour) and then processes what is stored, `card-update` first. It returns the new messages from contacts with the metadata of the untrusted-content wrapper (the sender under the contact-name rule with its identity label, the short owner fingerprint, the self-declared name for the block's `from` only), the processing outcomes, the requests count and the rate-limited counts. `client.catchUp({budgetMs})` only fetches and stores and returns `{inbox: [{contactId, unread}], requests}` from the store; it processes nothing (no handshake, ack, card update, receipt or read mark). With `AgentLinkClient.create({deliveryAcks: true})` (off by default, 02 F-23), `syncInbox` sends one signed `ack` (`{kind: "received", envelopeId}`, `replyTo` the message) per new message from a contact, never for an ack, and `client.acks.status(envelopeId)` reports whether that contact acknowledged a sent message. The Transport interface gains an optional `sync`, which `nostrTransport` implements. A `revoke` envelope is verified against the named agent's stored card and applied (`revoked_agents`, contact status `revoked` or the own identity revoked, pending outbox rows to that agent stopped as `revoked`) or dropped; it never stays `received`. The per-contact rate limit is counted where the contact's envelope is stored (`EnvelopeService` gains optional hooks, `revocation` and `rateLimit`, and the reasons `revoke_invalid` and `rate_limited`).
- a96e852: Add the send pipeline, the Transport adapter and the outbox over the Store to the core (M1-7k). `client.sendMessage({to, text | body, type, replyTo, clientRequestId})` sends a Talk message (`text`, `note`, `request`, `delivery`) to a paired contact: a `body` with a `terms` key returns `USE_TERMS_TOOLS` and stores nothing; the agent must be able to send and the policy must allow the contact (a paired contact may Talk while the policy fails closed, D-70), otherwise nothing is stored or published; one gift wrap per distinct recipient key, each routed to the relay list of the agent it concerns (the contact's list for the contact's agent and owner, the own list for the own owner and agent, the union when one owner owns both); the envelope and all of its outbox rows are stored in one transaction before the first publish; repeats under one `clientRequestId` return the original result and a different request returns `IDEMPOTENCY_KEY_REUSED`. `nostrTransport({connector, addressCheck, nip11})` builds the Transport from the runtime's relay I/O and is passed to `AgentLinkClient.create({transport})`; NIP-42 AUTH is signed only on the agent's own relays. `client.outbox.processDue()` gives staged envelopes (a pairing handshake or handshake-ack) their wraps once, then publishes due rows through transport-nostr's OutboxWorker; a per-row claim lets only one of several processes sharing the store republish a row, and another takes it over within 30 s if that process stalls or dies. `EnvelopeService.prepare` builds an envelope without storing it.
- a1465a6: Wire `agentlink_get_approval` and the `pendingApprovals` count of `agentlink_status` to the core approval read (M1-9c-b). Every request from an unknown sender now carries its sender code from core (`RequestEntry.senderCode`, and the code on an inbox request item): the short form, or the extended form when two unknown senders share the short form (04 §2.9). `agentlink requests` shows it. `@agentlink/types` adds `toolResultCommonSchema`, the one rule set for the common tool-result fields.

### Patch Changes

- c887320: `agentlink_accept_invite` now spells out its two steps: after the owner approves, call it again with the same invite link and the `approvalId`. Calling it again without the `approvalId` returns the request it already made instead of asking the owner a second time; once the owner has approved, it runs nothing and names the `approvalId` to use. Core adds `ApprovalService.findOpen`.
- d440819: Make the terms flow idempotent and independent of receive order (M1-32-b; IR-M1-9q-1 F-2, F-3). `proposeTerms` and `respondToTerms` take an optional `clientRequestId`: a repeat returns the original result and sends nothing, another request under the key returns `IDEMPOTENCY_KEY_REUSED`, a concurrent repeat returns `{status: 'in_progress'}`, and a repeat whose kept `pending_approval` was decided returns `{status: 'approval_state', approvalId, approval}`. On receive, an `offer` refused only because a version it links to has not arrived (version gap, unknown pointer) waits as `received` (new inbound reason `terms_waiting`) and is decided again in link order when other envelopes of its chain are taken; it is refused with `terms_refused` once 48 hours have passed since its signed createdAt (`TERMS_WAIT_SECONDS`).
- e1f2ba0: Adds the per-agent publisher lease (`client.publisherLease()`, store schema version 3 with the `publisher_lease` table) and bounds staged pairing messages: one still unsent after 24 h is marked not delivered, and one that keeps failing no longer blocks newer ones (`outbox_staged`).
- 0cc4ff3: Add `AgentLinkClient.close()` and an optional `Transport.close()` that close the relay connections of a client, so one-shot callers can end their process.
- d9e2711: `inbox.counts()` now counts only unread messages of the types an inbox page returns (`PAGE_TYPES`), so a received `proof` or protocol-type envelope no longer leaves an unread count that no inbox read clears (IR-M1-7h-c-1).
- Updated dependencies [1377cb5]
- Updated dependencies [0baa0a5]
- Updated dependencies [67c88fb]
- Updated dependencies [f805b00]
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
- Updated dependencies [e46e352]
- Updated dependencies [7355a84]
- Updated dependencies [8efcc8e]
- Updated dependencies [2b46ba4]
- Updated dependencies [66e997c]
- Updated dependencies [e02996f]
- Updated dependencies [a1465a6]
  - @agentlink/log@0.1.0
  - @agentlink/crypto@0.1.0
  - @agentlink/chain@0.1.0
  - @agentlink/transport-nostr@0.1.0
  - @agentlink/types@0.1.0
  - @agentlink/storage@0.1.0
