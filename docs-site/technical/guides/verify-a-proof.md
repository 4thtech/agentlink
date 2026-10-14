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

## Outline

- With the CLI: `agentlink verify <proof.json>` (v0.2.0)
- With the web page (v0.3.0): verification runs in your browser
- By hand, with any EVM library and a public RPC
- Reading the result: what it proves and what it does not
- Contract addresses: see [Contracts](../reference/contracts.md)

**Filled in at:** M1 (v0.2.0) and M2 (v0.3.0); backlog cards DOCS-M1b and DOCS-M2.
