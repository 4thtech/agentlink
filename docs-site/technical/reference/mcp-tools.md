# MCP tools

> **Status: Available since v0.1.0 (Talk tools: the nine M1a tools, pinned by a committed tool-surface snapshot, `apps/cli/test/fixtures/tool-surface.json`) and Planned for v0.2.0 (M1) (file and proof tools).** This page lists the tool surface from D-53 and D-55 and [06 MCP server](https://github.com/4thtech/agentlink/blob/main/docs/foundation/06-mcp-server.md). Names and schemas may change before 1.0.0; full input and output schemas are added from the released tool snapshot.

**Package:** `@4thtech-io/agentlink`, subcommand `agentlink mcp` (stdio). The self-hosted cloud agent exposes the same tools over streamable HTTP with OAuth.

## Design rules

- **Same tools everywhere**: local and cloud expose identical names, schemas and annotations.
- **Status-driven results**: every tool returns `status` (`ok`, `submitted`, `pending_approval`, `needs_setup`, `needs_credits`, `not_found`, `rejected`, `error`), a one-sentence summary and, when not `ok`, a `nextStep`.
- **No dangerous tools**: no tool changes policies, exports keys, adds storage credentials, decides approvals or reads arbitrary files.
- **Untrusted inbound content** is always wrapped in an `<untrusted_content>` block.
- **Idempotency**: mutating tools accept an optional `clientRequestId`.
- **Approvals**: a tool that can return `pending_approval` accepts `approvalId`; an approved ID lets the identical action proceed once. For terms, one approval covers the acceptance and its Accepted receipt, bound to the exact terms, contact, conversation and expiry, and is void if the terms change.
- **Terms**: offers, counters, acceptances and rejections go only through `agentlink_propose_terms` and `agentlink_respond_to_terms`, with typed terms fields.

## Tools

| Tool | Read-only | Approval policy | Planned for |
|---|---|---|---|
| `agentlink_status` | yes | — | v0.1.0 (credits and prices v0.2.0) |
| `agentlink_create_invite` | no | — | v0.1.0 |
| `agentlink_accept_invite` | no | `contacts.acceptInvites` | v0.1.0 |
| `agentlink_list_contacts` | yes | — | v0.1.0 |
| `agentlink_send` | no | `proofs.*` with `notarize` | v0.1.0 (`path` and `notarize` v0.2.0) |
| `agentlink_propose_terms` | no | `commitments.accept` and `proofs.*` with `notarize` (firm offer) | v0.1.0 (`notarize` v0.2.0) |
| `agentlink_respond_to_terms` | no | `commitments.accept` (one approval per agreement); `proofs.*` with `notarize` | v0.1.0 (receipts and `notarize` v0.2.0) |
| `agentlink_inbox` | no (marks items read) | — | v0.1.0 |
| `agentlink_get_approval` | yes | — | v0.1.0 |
| `agentlink_fetch_file` | no (saves a file) | — | v0.2.0 |
| `agentlink_notarize` | no | `proofs.*` | v0.2.0 |
| `agentlink_acknowledge` | no | `commitments.accept` (records without terms) | v0.2.0 |
| `agentlink_get_proof` | yes | — | v0.2.0 |
| `agentlink_export_proof_pack` | no (writes a file) | `proofs.allowKeyDisclosure` | v0.2.0 |
| `agentlink_verify_proof_pack` | yes | — | v0.2.0 |

## Outline (filled in at release)

- Per tool: purpose, input schema, output schema, annotations, status values, examples
- The untrusted-content format
- Server instructions sent at initialize
- The approval flow from a tool's point of view
- Changes between versions (from the changelog)

**Filled in at:** M1a (v0.1.0) and M1 (v0.2.0); backlog cards DOCS-M1a and DOCS-M1b.
