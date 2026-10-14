# Policies

> **Status: Planned for v0.1.0 (M1a)** (contacts, commitments) **and v0.2.0 (M1)** (files, proofs, receipts). This page is an outline. Defaults are specified in [06 §3](https://github.com/4thtech/agentlink/blob/main/docs/foundation/06-mcp-server.md) and are added here, with their final names, when they ship.

**Purpose:** the reference for every policy key, its default and what it allows.

Policies are owner-signed documents, stored locally and verified on load. They change only through the CLI, the local UI, the desktop app or the console, with owner presence; never through an MCP tool.

## Outline

- `contacts`: accepting invites, unknown senders, allowed contacts, rate limits
- `files`: allowed folders, inbox folder, size limits, storage choice (encrypted drop or own storage), expiry, delete after expiry or receipt
- `proofs`: notarize allow, approval or deny; daily budget; per-action maximum; key disclosure; export folder
- `receipts`: automatic `DELIVERED`; `OPENED` only on request
- `commitments`: accepting terms (approval by default), auto-accept allowlist and maximum value
- How a change is signed and applied

**Filled in at:** M1a (v0.1.0) and M1 (v0.2.0); backlog cards DOCS-M1a and DOCS-M1b.
