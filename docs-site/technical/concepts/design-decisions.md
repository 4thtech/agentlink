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

### Revoking an agent (D-81)

An owner revokes an agent by signing an EIP-712 `Revocation` with four fields: `agentEvm`, `keyEpoch` (uint32), `nonce` and `deadline`. The contract checks that the signer is the stored owner, that the key epoch matches, and that the nonce is unused. Registration and revocation share one set of single-use random nonces per owner. Revocation also works while the contracts are paused, so an owner can always cut off a compromised agent. Revoking an unknown or already-revoked agent reverts.

**Availability.** The signing data and its vectors are merged in the crypto package; the contract side lives in the private contracts repository and the registry is planned for M2.

## Packages

### The internal package scope `@4thtech-io` (OPS-REL-2)

Workspace packages are named `@4thtech-io/*` (`crypto`, `core`, `node`, `types`, `transport-nostr`, `storage`, `log` and so on). They are private and bundled. The only package on npm is the command-line package **`@4thtech-io/agentlink`**. Check that exact name when you install, so you do not install a look-alike.

### The contracts ABI package stays private (D-83)

`@4thtech-io/occ-v2-abi` is a private workspace package. It is built from the ABI files, per-chain addresses and checksum manifest that the private contracts repository exports with each tagged release, and from the shared test vectors. It is bundled into the CLI and **never published to npm** as a separate package. CI checks the imported files against the release manifest and fails if any Solidity source is present in this repository. The chain client pins the imported release exactly, and dependency updates for it are never merged automatically.

## Reading further

- [Files](files.md), [Records, receipts and proof packs](proof.md), [Security model](security-model.md)
- [SDK packages](../reference/sdk-packages.md) and [Contracts](../reference/contracts.md)
