# Verify a proof independently

> **Status: Planned for v0.2.0 (M1)** (CLI) **and v0.3.0 (M2)** (web page). This page is an outline. The method below is the design; commands and screenshots are added when the tools ship.

**Purpose:** check a proof pack without an AgentLink account, without the AgentLink apps if you prefer, and without trusting any 4thTech server.

## What a verifier checks (design)

1. **The record exists** on the chain named in the pack: call `getRecord(recordId)` on the `OCCNotary` contract through any public RPC.
2. **The record matches the pack:** signer, timestamp, envelope hash, kind and the EIP-712 struct hash of the record fields.
3. **The signature** in the pack is valid for the signer under the OCC v2 EIP-712 domain.
4. **Receipts:** the receipt timestamps stored in the record; with a disclosed recipient address and salt, that they open the recipient commitment.
5. **Identity (optional):** the agent card is signed by the claimed owner; registration in `OCCRegistry` (M2); domain verification (M2).
6. **Content (optional):** with a disclosed content key and the envelope, decrypt and confirm that the envelope hashes to the recorded value; for agreements, recompute `termsHash`.

## Verifying with the AgentLink tool (in development)

`agentlink_verify_proof_pack` is read-only. Give it the pack itself, or a `path` inside your proof export folder or inbox folder; any other path is refused with a fixed code and no file contents are echoed (G-25, decided design). Everything read from the pack is treated as untrusted, and the chain is read only through your configured RPC at the known contract address. Details: [Design decisions](../concepts/design-decisions.md).

## How the verifier works (in development)

> **Status: in development (M1-4d).** The check below is built in `@4thtech-io/chain` (`verifyProofPack`) and is not user-facing yet; the CLI command and the tool arrive with M1-9h and M1-9d-2.

The pack is untrusted input. The verifier never echoes it: every failure is a fixed code with fixed plain-language text, and no RPC address or server text appears in a result.

1. **Size and shape.** At most 256 KiB. Strict JSON (no duplicate keys, whole numbers only) and the strict pack v1 schema: one spelling per value, nothing normalised. A shared content key without the message it opens, a key that is not exactly 32 bytes and a record type outside the six fixed ones (D-86) each have their own code.
2. **Network and contract.** The pack's `chainId` must be a network this release ships; the pack's contract address must equal the shipped proof contract for it. The verifier never reads an address or an RPC from the pack.
3. **Record ID.** Recomputed from the network, the contract, the signer and the nonce, as the contract does.
4. **One `getRecord` read.** The stored signer, record type, envelope hash, recipient commitment and the EIP-712 struct hash of all the record fields must equal the pack's. No event logs are read (some RPCs prune them).
5. **Signature.** As the contract checks it: a canonical ECDSA signature that recovers the signer, otherwise an ERC-1271 account at the signer address that accepts it (`isValidSignature` through a read call). A contract account is asked at verification time, so an account that has since changed its rules can answer differently than it did at inclusion.
6. **Recipient and receipts.** A disclosed recipient and salt must open the commitment. Receipts are taken from the record's stored receipt times; each receipt the pack lists must be there, at the same second.
7. **Content (only with a shared content key), in this order, fail closed:** strict envelope parse; its hash equals the pack's and the record's; its signature verifies under its sender; the key commitment matches the shared key (a key that opens a two-key ciphertext under AES-GCM but not the commitment is refused); decrypt; the strict message schema; then the message type must map to the record type (D-86). A failure here means the pack proves no content; the record and its receipts still verify.

## Outline

- With the CLI: `agentlink verify <proof.json>` (v0.2.0)
- With the web page (v0.3.0): verification runs in your browser
- By hand, with any EVM library and a public RPC
- Reading the result: what it proves and what it does not
- Contract addresses: see [Contracts](../reference/contracts.md)

**Filled in at:** M1 (v0.2.0) and M2 (v0.3.0); backlog cards DOCS-M1b and DOCS-M2.
