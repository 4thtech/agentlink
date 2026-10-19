# Design decisions

> **Status: Mixed.** These are decisions the owner has taken, written for developers and integrators. Each one says what is built and what is still in development. In the released CLI package (npm `latest`, 0.1.x) you can pair, talk and negotiate terms; sending files and proof through the tools is in development. The numbered decisions (D-n) and gaps (G-n) are in the [decision log](https://github.com/4thtech/agentlink/blob/main/docs/foundation/00-README.md); the specs win on any conflict.

**Purpose:** explain why files, proofs and packages work the way they do, so you can build against them or review them.

## Files

### Encrypted file format `ALF1` (D-80)

A file is encrypted on the sender's device as a stream of chunks, so a large file never has to fit in memory and a truncated or edited file fails to decrypt.

| Part | Rule |
|---|---|
| Header (17 bytes) | `"ALF1"` (4 bytes), version (1 byte), chunk size (4 bytes, big-endian), nonce prefix (8 bytes) |
| Version byte | `0x01` only; any other value is refused |
| Chunk size | 1 byte to 16 MiB; default 1 MiB |
| Chunk count | At most 2^32 |
| Each chunk | AES-256-GCM with nonce `noncePrefix ‖ u32be(chunkIndex)` |
| Authenticated data | The 17 header bytes followed by one byte: `1` for the final chunk, `0` otherwise |
| Last chunk | A plaintext that is an exact multiple of the chunk size ends with a full final chunk. An empty final chunk exists only for the empty file |

Because the header and the final-chunk flag are part of every chunk's authenticated data, changing the header, reordering or dropping chunks, or cutting off the end is detected (the STREAM construction). Header integrity does not rest on the file hash alone.

**Availability.** The encryption and decryption code is merged in the crypto package, with independent test vectors. Sending and receiving files through the MCP tools is in development.

### Verifying a download without holding it in memory (D-84)

A recipient verifies the ciphertext hash (`ciphertextSha256`) before any plaintext is released, and the plaintext hash (`plaintextSha256`) after. A streaming download cannot hash the whole object before the first chunk is decrypted, so it uses a **quarantine**:

1. Create a new hidden temporary file in the target folder: created exclusively, links not followed, mode 0600.
2. Decrypt into it chunk by chunk. Every chunk is authenticated, so nobody else can place plaintext in it.
3. After the final chunk, check both hashes. Only then rename it into place.
4. On any failure, delete it. Stale quarantine files are removed at start-up.

Nothing is accepted before both hashes pass, so every party that receives the same envelope gets the same file bytes or a failure. The residual risk is that unverified plaintext, written by the sender, sits in the hidden file until the end. Small inline files are held in memory, are hash-checked before decryption and need no quarantine.

**Availability.** Streaming upload and download for your own S3-compatible storage is merged; the user-facing file tools are in development.

### What goes inline and what goes to storage (G-27, D-85)

A file travels inline, inside the encrypted envelope, only if both limits hold:

- its `ALF1` ciphertext is at most 12 288 bytes (a plaintext of at most 12 255 bytes), and
- the whole serialized payload (what is encrypted into the envelope) stays at most 17 136 bytes.

The sender marks every file within the first limit as inline. While the payload is too big, it moves the largest inline file to storage (ties go to the highest index). After any uploads it checks again; if it still does not fit, the send is rejected with `PAYLOAD_TOO_LARGE`, nothing is sent and uploaded objects are deleted. The size limit is the receiver's own, so a message the sender accepts is never one the receiver must refuse. A message may carry up to 16 files.

**Availability.** Decided design, in development (card M1-7f). Today only the inline adapter's per-file limit is built.

### Encrypted drop by default (D-48)

Files above the inline limit go by default to the 4thTech **encrypted drop**, a zero-knowledge service that stores ciphertext only, so sending a file needs no setup. Your own S3-compatible storage is used instead when you configure it, or when policy `files.storage` says `own`. In both cases the file key, the file name and the plaintext hash travel only inside the end-to-end-encrypted envelope.

The drop uses random object names, no accounts (each upload is signed by a dedicated drop key that cannot be linked to your agent), per-key quotas, aggregate counters in place of request logs and a hard 7-day expiry. If the drop is compromised it can refuse, delete or delay a file, but it cannot read it or change it unnoticed. See [Files](files.md).

**Availability.** The drop service and its deployment pipeline are merged and tested locally; it is not yet live for users, and the tools that use it are in development.

### Deleting a received file's key (D-98)

When a message with files arrives, the receiving agent moves each file key out of the stored message into its own encrypted local record. When the file's retention ends (`files.deleteAfter`: at expiry by default, or on receipt), that record is deleted, and the sender deletes the stored object. Copies of the message held by relays and by the owners' own copies still carry the key, inside the end-to-end encryption, and nobody can delete those. The key is then useless because the encrypted file it opens is gone: deleting the object is what really removes the file.

**Availability.** Decided design, in development (card M1-7f-2).

### Allowed folders never contain a protected folder (D-99)

`agentlink policy allow-folder` refuses a folder that contains a protected folder, for example `~/Library`, which holds `~/Library/Keychains`. The refusal names the protected folder and suggests choosing a narrower folder. It happens before the owner code is asked, so nothing changes. Before this, only the per-file check at send time kept such files out.

**Availability.** Merged for the next release (card M1-9m-b).

### Recovering rules that can't be read (D-100)

When the agent's signed rules (policy) can't be trusted (rolled back, out of step with the stored version mark, or tampered with), AgentLink fails closed and never falls back to the defaults on its own. `agentlink policy recover` is the owner's deliberate way back. It shows only the kind of failure. If the stored rules still parse and their signature checks out (a rollback or a version mismatch), the owner reviews those rules in full; otherwise the owner reviews the built-in defaults in full. After an explicit `y` and the owner code, it signs a complete new policy at a version above both the stored version mark and the stored rules' own version (D-103, amending D-100), so the recovered rules can't land at or below a version that is already ahead. `agentlink doctor` names the command when it is needed.

**Availability.** Merged for the next release (card M1-9m-b).

## Proof

### Which record kind goes with which message (G-13, D-86)

A proof record carries a public `kind`. The core sets it from the message type; no tool takes a kind from the caller.

| Message type | Record kind |
|---|---|
| `offer` | OFFER |
| `accept` | ACCEPT |
| `delivery` | DELIVERY |
| `note` | NOTE |
| `file` | FILE |
| `text`, `request` | FILE when the message carries files, otherwise MESSAGE |
| `reject` | MESSAGE |
| Everything else (acknowledgements, handshakes, proofs, approvals, policies, card updates, revocations) | Never recorded; the call returns `NOT_NOTARIZABLE` |

Values above 6 are reserved; adding one is a spec change. The kind is public and permanent, so it shows the category of a message, never its content. Before signing a receipt, a recipient checks that the record's kind matches this table for the envelope it holds; if not, it signs nothing and flags the contact. A verifier who is given the content key applies the same check. On a mismatch the pack proves no content, while the record and receipts are still verified.

**Availability.** Decided design, in development (card M1-7g). Proof is not yet available through the tools.

### Verifying a proof pack reads only two folders (G-25, D-87)

`agentlink_verify_proof_pack` takes either the pack itself or a `path`. A path must lie inside the proof export folder or the inbox folder, and is checked in this order:

1. A lexical check on the normalised path; a path outside both folders is refused before the disk is touched.
2. The real path is resolved, links are not followed, and the target must be a regular file of at most 256 KiB whose device and inode match the resolved path.
3. Failures return a fixed code (`PATH_NOT_ALLOWED`, `PACK_TOO_LARGE`, `PACK_INVALID`) and never echo file contents, parse details or the resolved path.

The pack is untrusted content: every value taken from it is shown as untrusted, and the verifier reads the chain only through your configured RPC and only from the known contract address of a supported chain, never from an address or URL in the pack. This keeps the rule that no tool reads arbitrary files. See [Verify a proof independently](../guides/verify-a-proof.md).

**Availability.** Decided design, in development (card M1-9d).

### A card alone does not confirm the sender, for now (D-95)

Until agent-card proof-of-possession is built (its own card, M1-4d-d), a proof pack whose sender attribution relies on a card reports `record_only`, not `verified`. The record, its signature and its receipts are still checked on their own. The result says in neutral words that the record exists and that the pack does not confirm the sender.

**Availability.** In effect in the verifier (card M1-4d-b, merged). Proof of possession is specified next and built in card M1-4d-d.

### Proof of possession for the sender's card (M1-4d-d, D-102)

A pack confirms its sender only when both of the agent's keys have signed its card: the agent's EVM key (`cardAgentSig`, the same signature the agent already gives when it pairs) and its message key (`cardPop`, a BIP-340 signature over the card hash under the tag `agentlink/card-pop/v1`). Both are made once per card (at setup, when another agent is added, and with every card update), never per pack, and each fits only the card it was made for. They travel with the card in the pairing messages and in card updates, so a recipient can export a pack for the sender's record that still confirms the sender. A pack with a card but without these signatures stays `record_only` (`card_pop_missing`); a forged signature, or one taken from another card, makes the pack fail with `card_pop_invalid`; a pack with both, whose content checks out, is `verified`. A signer that is a smart-contract account is not confirmed through a card in this version; that comes later (card M1-4d-e).

**Availability.** Decided design (07 §8, 04 §2.9), in development (card M1-4d-d).

### Card updates follow the contact list (M1-4d-f, D-106)

When an agent's keys change, it sends its new card (with both of its signatures) to its contacts in a card update. It sends one only to contacts that the owner's contact list (`contacts.allowed`) permits, the same check every other message gets. While the owner's rules can't be read, it sends none, and catches up once the owner has fixed them. The agent also keeps its own earlier cards, so a proof for a message sent before a key change still names the sender.

**Availability.** Decided design, in development (card M1-4d-f).

### A smart-contract signer that no longer confirms (M1-4d-c, D-96)

The verifier asks a smart-contract account (ERC-1271) at verification time whether it accepts the record's signature. The account may have changed its rules since the proof network checked the signature when it stored the record. If it no longer accepts it, the pack does not fail: the result carries the non-fatal code `signer_no_longer_confirms` next to an unchanged verdict, with the text "The signer's account no longer confirms this record. The proof network checked it when the record was made."

**Availability.** Built in the verifier (card M1-4d-c); not user-facing until the `verify` command and tool land.

### Receipt flags (D-97)

The record keeps one bit per receipt type: type `t` sets bit `t − 1` (DELIVERED bit 0, OPENED bit 1, ACCEPTED bit 2, REJECTED bit 3), next to the receipt's time in `receiptAt[t − 1]`. The verifier checks that the bits and the times agree, that no other bit is set and that ACCEPTED and REJECTED are not both set; any mismatch is `malformed_record`.

**Availability.** Built in the verifier (card M1-4d-c); not user-facing until the `verify` command and tool land.

### Checking the owner's approval in a proof pack (M1-4d-c, D-104)

A proof pack can carry the owner's signed approval for the agreement. The verifier checks, in order and failing closed: the owner's signature under the owner-action tag; that the signed digest is the digest of the exact action; that the terms fingerprint is the fingerprint of the stored terms; that the approval concerns this record (by the recipient, its scope names the record's message; by the signer, the disclosed content must carry the approved terms and, for an accept, answer the approved message); and that the owner key matches the signer's card when the pack carries one. Any failure fails the pack with `owner_approval_invalid`. An approval by the signer without disclosed content is reported as not tied to this record and is never shown as approving it. A standing rule is reported by its fingerprint and not checked, since the rules themselves are not in the pack.

**Availability.** Built in the verifier (card M1-4d-c); not user-facing until the `verify` command and tool land.

### A receipt link that doesn't match is a warning (M1-4d-c, D-105)

A receipt stands on the record the proof network stores. The transaction hash a pack lists for a receipt is only a link: the verifier confirms it when that transaction carries the proof contract's `ReceiptRecorded` event for this record, receipt type, signer and time. A hash that doesn't confirm gives the non-fatal code `receipt_tx_mismatch` next to an unchanged verdict, and is never shown as a link; a hash the network doesn't show, or a failed read, is reported as not checked.

**Availability.** Built in the verifier (card M1-4d-c); not user-facing until the `verify` command and tool land.

### Revoking an agent (D-81)

An owner revokes an agent by signing an EIP-712 `Revocation` with four fields: `agentEvm`, `keyEpoch` (uint32), `nonce` and `deadline`. The contract checks that the signer is the stored owner, that the key epoch matches, and that the nonce is unused. Registration and revocation share one set of single-use random nonces per owner. Revocation also works while the contracts are paused, so an owner can always cut off a compromised agent. Revoking an unknown or already-revoked agent reverts.

**Availability.** The signing data and its vectors are merged in the crypto package; the contract side lives in the private contracts repository and the registry is planned for M2.

### The proof tools are their own security-critical card (M1-9d-2, D-101)

The proof half of the file and proof tools (notarizing on send, propose and respond; `agentlink_notarize`, `agentlink_acknowledge`, `agentlink_get_proof`; exporting and verifying proof packs; credits and prices in `agentlink_status`) is its own card with the strictest review class, because it can disclose a content key and spend credits.

**Availability.** In development (card M1-9d-2).

### Both sides can export a proof pack (M1-7g-b, D-107)

A proof of agreement should be exportable by either party, not only by the side that paid for the record. So the follow-up `proof` message that tells the recipient about a record also carries the signed record and its signature. The message is end-to-end encrypted to the recipient only; nothing new reaches any 4thTech service, and the record and signature are already public in the transaction that stored the record. Before keeping them, the recipient checks them against the record on the proof network and against the message it received (record hash, record ID, signer, kind, its own commitment and the signature); if anything does not match, it drops the whole `proof` message and signs no receipt. The recipient's pack leaves out the recipient's own address and salt unless it asks for them, as on the sender side. A `proof` message from an older version without the record still works for receipts, but the recipient cannot export a pack for it (`RECORD_UNAVAILABLE`).

**Availability.** Decided design (04 §3.4, 07 §8), upcoming (card M1-7g-b). Until it lands, only the side that recorded can export.

## Packages

### The internal package scope `@4thtech-io` (OPS-REL-2)

Workspace packages are named `@4thtech-io/*` (`crypto`, `core`, `node`, `types`, `transport-nostr`, `storage`, `log` and so on). They are private and bundled. The only package on npm is the command-line package **`@4thtech-io/agentlink`**. Check that exact name when you install, so you do not install a look-alike.

### The contracts ABI package stays private (D-83)

`@4thtech-io/occ-v2-abi` is a private workspace package. It is built from the ABI files, per-chain addresses and checksum manifest that the private contracts repository exports with each tagged release, and from the shared test vectors. It is bundled into the CLI and **never published to npm** as a separate package. CI checks the imported files against the release manifest and fails if any Solidity source is present in this repository. The chain client pins the imported release exactly, and dependency updates for it are never merged automatically.

## Contracts and the submitter

### Gasless deposits: the flag is off-chain, the vault checks the amount (G-17, D-89)

Whether a token supports gasless authorization (EIP-3009) is a flag in the per-chain configuration, read by the client and the submitter, which never offer the path for an unflagged token. The vault stores no flag. Its `depositWithAuthorization` requires an allowed token and a deposit at or above the minimum, measures its own balance before and after the token call, and reverts with `DepositMismatch()` unless the increase equals the stated value. A token that accepts the call but moves nothing therefore cannot credit anyone. **Availability.** Decided design; the contract work (M1-3c) is in the private contracts repository.

### Which signers share a transaction, and the submitter defaults (FA-1, FA-3, D-93, D-94)

The submitter sends a signer that has code (a smart-contract account, or an address with an EIP-7702 delegation) alone in its transaction from its first item, so one such signer cannot cause other signers' items to be lost. Its defaults, each a setting: 600 items per IP per hour; 120 new items per signer per hour; 24 hours retention of finished items; a 25,000 gas margin over the simulated gas; and a ceiling of 700,000 gas per item, to be lowered once the audited bound on signature-check gas lands (M3-1a). Items already on-chain are reported as skipped and count against the IP, not the signer. **Availability.** Decided design, in development (card M1-10a).

### Per-contact proof rules and lifetimes are confirmed (G-7, G-32, D-90)

The lifetimes of owner-signed operations and approvals, the rolling 24-hour proof budget, and the per-contact proof rules created by "Remember for this contact" (proof approvals only, never budget, commitments, files or new contacts) are accepted as specified. A global "never" and the daily budget always win over a remembered rule.

## Delivery

### Production is the beta (G-40, D-88)

There is no separate beta environment. Staging (`workers.dev`) serves CI and smoke tests only. Production (`*.agentlink.4thtech.io`) serves the testnet beta in the first milestones and mainnets from M3, with automatic promotion after the staging smoke test. One Cloudflare account hosts both Wrangler environments, and gas and faucet keys are separate per environment.

### The Claude Desktop extension is optional (M1-9f, D-91)

A one-click Claude Desktop extension is an optional convenience package for one harness. The product stays harness-agnostic: every MCP harness, Claude Desktop included, uses the same `npx -y @4thtech-io/agentlink` server. The bundle is built in CI from the npm release and pinned to its version, is self-contained, and is attached to the GitHub release with its SHA-256 and a build provenance attestation. It is signed when the format supports it (self-signed in the beta). A directory listing is planned for M3.

### The Gnosis Chiado testnet deployment (M1-3j, D-92)

The owner decided to go ahead with the Chiado testnet deployment at the same addresses as Base Sepolia. The work is carded separately.

## Reading further

- [Files](files.md), [Records, receipts and proof packs](proof.md), [Security model](security-model.md)
- [SDK packages](../reference/sdk-packages.md) and [Contracts](../reference/contracts.md)
