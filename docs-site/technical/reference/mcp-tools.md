# MCP tools

> **Status: Available since v0.1.0 (Talk tools: the nine M1a tools, pinned by a committed tool-surface snapshot, `apps/cli/test/fixtures/tool-surface.json`) and Planned for v0.2.0 (M1) (file and proof tools).** Current for v0.4.6 (31 Oct 2026): the tool surface did not change in 0.4.6; what changed is behaviour, described under "Paused agents" and "Received files" below. This page lists the tool surface from D-53 and D-55 and [06 MCP server](https://github.com/4thtech/agentlink/blob/main/docs/foundation/06-mcp-server.md). Names and schemas may change before 1.0.0; full input and output schemas are added from the released tool snapshot.

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
| `agentlink_status` | yes | — | v0.1.0 (credits and prices: next release) |
| `agentlink_create_invite` | no | — | v0.1.0 |
| `agentlink_accept_invite` | no | `contacts.acceptInvites` | v0.1.0 |
| `agentlink_list_contacts` | yes | — | v0.1.0 |
| `agentlink_send` | no | `proofs.*` with `notarize` | v0.1.0 (`path` and `notarize`: next release) |
| `agentlink_propose_terms` | no | `commitments.accept` and `proofs.*` with `notarize` (firm offer) | v0.1.0 (`notarize` accepted next release; firm offers v0.2.0) |
| `agentlink_respond_to_terms` | no | `commitments.accept` (one approval per agreement); `proofs.*` with `notarize` | v0.1.0 (`notarize` accepted next release; recorded accepts v0.2.0) |
| `agentlink_inbox` | no (marks items read) | — | v0.1.0 |
| `agentlink_get_approval` | yes | — | v0.1.0 |
| `agentlink_fetch_file` | no (saves a file) | — | next release |
| `agentlink_notarize` | no | `proofs.*` | next release |
| `agentlink_acknowledge` | no | `commitments.accept` (records without terms) | next release |
| `agentlink_get_proof` | yes | — | next release |
| `agentlink_export_proof_pack` | no (writes a file) | `proofs.allowKeyDisclosure` | next release |
| `agentlink_verify_proof_pack` | yes | — | next release |

## File tools (next release, M1-9d-1)

- **`agentlink_send` with `path`** (06 §2.2, §2.3): `path` is the full path of one file (`~/` allowed; 1 to 4096 characters, no control character). `text`, `body` or `path` is required; `text` and `body` exclude each other. Before the core is called, the path is resolved with realpath and must be strictly inside a `files.allowedFolders` entry (04 §4); the file is not opened. Results: `needs_setup` with `NO_ALLOWED_FOLDER` or `OUTSIDE_ALLOWED_FOLDER` (also for a link that points outside); `rejected` `PATH_NOT_ALLOWED` (relative, `.` or `..`, hidden, protected, not a regular file); `not_found` `FILE_NOT_FOUND`; `needs_setup` `NEEDS_OWN_STORAGE` (above the drop's size or weekly limit, or `files.storage: own` with none set up); `rejected` `FILE_TOO_LARGE`, `PAYLOAD_TOO_LARGE`, `POLICY_DENIED`; `error` `STORAGE_UNAVAILABLE`, `STORAGE_FAILED`, `FILE_CHANGED`, `FILES_UNAVAILABLE`. On `ok`, `file` is `{name, size, plaintextSha256, delivery: inline | drop | own, expiresAt}`: never a link, a locator or a key.
- **`agentlink_fetch_file`** (06 §2.3): `{envelopeId, fileIndex? = 0}` (0 to 15). On `ok`: `{savedTo, name, size, integrity: "verified"}`; `name` and the last segment of `savedTo` are the sender's sanitised text, so the text result shows the name only inside the untrusted block. Refusals: `not_found`; `rejected` `FILE_TOO_LARGE`, `INTEGRITY_FAILED`, `LINK_EXPIRED`, `URL_REFUSED`, `POLICY_DENIED`; `error` `INBOX_UNAVAILABLE`, `DOWNLOAD_FAILED`, `FILES_UNAVAILABLE`. Annotations: not read-only (it writes a file), not idempotent (each call saves a new copy), open world.
- **`agentlink_status`**: `storage.mode` is where files above about 12 KB go under the current rules (`drop` or `own`).

## Received files and `agentlink_fetch_file` (since 0.4.6, D-142)

Files from contacts you keep are now saved automatically by the agent itself, without any tool call (see [Files](../concepts/files.md#automatic-saving-since-046)). `agentlink_fetch_file` still works with the same input, output and statuses and is your request, so the automatic-saving limits, the off switch and "Ask before saving" do not hold it back. It shares one lock per file with automatic saving and with Save in the app. When the file was already saved and the saved copy still hashes to the expected SHA-256 and size, it answers `{savedTo, name, size, integrity: "verified"}` from that copy without downloading again and without writing a second copy. If the copy was moved, deleted or changed, it downloads again under a new name while the link is valid.

## Paused agents (since 0.4.6, D-143 (5))

While the owner has paused an agent in the app, the tools that send or fetch (`agentlink_send`, `agentlink_acknowledge`, `agentlink_propose_terms`, `agentlink_respond_to_terms`, `agentlink_notarize`, `agentlink_create_invite`, `agentlink_accept_invite`, `agentlink_fetch_file`) return `rejected` with `code: "AGENT_PAUSED"` and the fixed `nextStep` "This agent is paused. The owner can resume it in the AgentLink app." The call is refused before any effect, is not queued and is not kept under its `clientRequestId`, so the same call works after Resume. The read tools (`agentlink_status`, `agentlink_inbox`, `agentlink_list_contacts`, `agentlink_get_approval`, `agentlink_get_proof`, `agentlink_export_proof_pack`, `agentlink_verify_proof_pack`) answer from what the store holds with no relay fetch, and `agentlink_status` adds the same fixed line. No tool, argument, result field or annotation was added, and no tool or command pauses or resumes an agent (I-4). Pause is one click in the app with no Touch ID; Resume needs Touch ID and signs `agent.resume`.

## Proof tools (next release, M1-9d-2)

Proofs run on test networks only. They need the 4thTech proof submitter and test credits to be running; until then a proof stays `submitted` and is sent again later. The network is chosen automatically (D-40); no default input asks for one.

- **`agentlink_notarize`** (06 §2.4): `{envelopeId, requestReceipt?, approvalId?, clientRequestId?}` for a message this agent sent. The proof network is picked automatically. Only `agentlink mcp --advanced` adds `chain?`, an override (a supported network's key) used only when the user asks; an unknown one is `rejected` `UNSUPPORTED_CHAIN`. On the default surface a `chain` argument is refused with `INVALID_ARGUMENT` (M1-36h). Results (a ProofStatus: `recordId`, `fee {token, amount, usd}`, `receipts`, and the proof network only as `advanced.chain`): `ok`; `submitted`; `needs_credits` with `agentAddress` and `topUpUrl` (the deposit page, `https://pay.agentlink.4thtech.io/`; the link carries nothing else); `pending_approval` (policy `proofs.*`); `error` `USE_TERMS_TOOLS` for an `offer`, `accept` or `reject` (nothing is recorded), `RECORD_FAILED`, `RECORD_CONFLICT`, `CHAIN_UNAVAILABLE`, `PROOFS_UNAVAILABLE`, `NETWORK`; `not_found` `ENVELOPE_NOT_FOUND`; `rejected` `NOT_NOTARIZABLE`, `POLICY_DENIED`, `CARD_EXPIRED`, `UNSUPPORTED_CHAIN`, `APPROVAL_INVALID`, `POLICY_CHANGED`.
- **`notarize` on `agentlink_send`** (06 §2.2): the message is sent, then recorded under the same `proofs.*` policy as `agentlink_notarize`. The result adds `proof` (a ProofStatus); a proof that is pending, submitted or short of credits gives the result its status, and a failed proof gives `error` with `proof.status: "error"` and a fixed code, with the send fields kept; the summary always says the message was sent. A `pending_approval` is finished with `agentlink_notarize` and the `envelopeId`; a repeat of `agentlink_send` with `approvalId` must carry the first call's `clientRequestId` (otherwise `INVALID_ARGUMENT`, nothing sent).
- **`notarize` on `agentlink_propose_terms` and `agentlink_respond_to_terms`** (06 §2.2a): accepted by the schema and passed to the core, which does not record offers or answers yet: `error` `NOTARIZE_UNAVAILABLE`, nothing sent or signed. Firm offers and recorded accepts come with v0.2.0.
- **`agentlink_acknowledge`** (06 §2.4): `{envelopeId, type: opened | accepted | rejected, approvalId?, clientRequestId?}` on a message a contact recorded. `opened` only when the user asked to open it. Results: `ok` `{recordId, receipt}`; `submitted` (signed, not on record yet); `pending_approval` (`commitments.accept` for accepted or rejected); `error` `USE_RESPOND_TO_TERMS` for a record with terms (nothing signed); `not_found` `NOT_RECORDED`, `ENVELOPE_NOT_FOUND`; `rejected` `RECEIPT_CONFLICT`, `POLICY_DENIED`, `APPROVAL_INVALID`.
- **`agentlink_get_proof`** (06 §2.4): exactly one of `envelopeId` and `recordId`. Read-only. A ProofStatus by the stored state: `ok`, `submitted`, `needs_credits`, `error`, or `not_found`.
- **`agentlink_export_proof_pack`** (06 §2.4, 07 §8): exactly one of `envelopeId` and `recordId`, plus `includeContentKey?` (default false; needs the owner's approval, `proofs.allowKeyDisclosure`) and `includeRecipient?` (default false). Writes a new file into `proofs.exportFolder` (`~/AgentLink/Proofs` by default); nothing is written before the approval. On `ok`: `{savedTo, recordId}`, never the pack or a key. Refusals: `not_found` `NOT_RECORDED`, `ENVELOPE_NOT_FOUND`; `error` `RECORD_UNAVAILABLE` (a record a contact made), `EXPORT_FOLDER_UNAVAILABLE`; `rejected` `POLICY_DENIED`, `APPROVAL_INVALID`.
- **`agentlink_verify_proof_pack`** (06 §2.4, D-87): exactly one of `path` and `json`. `path` must be strictly inside `proofs.exportFolder` or `files.inboxFolder` (a relative path is below the proofs folder): a path outside both is refused before the disk is touched; then realpath, no hidden or protected files, no links, a regular file of at most 256 KiB. Refusals are `rejected` `PATH_NOT_ALLOWED`, `PACK_TOO_LARGE`, `PACK_INVALID`, with no path or content echoed. On `ok`: `{valid, verdict: verified | record_only | failed, advanced: {chain}, recordId, signer, signerName?, signerLabel?, timestamp, envelopeHash, receipts, contentVerified}`. `signerName` follows the contact-name rule: the contact's alias or restricted name, otherwise "Contact" with the short owner fingerprint. `record_only` is never shown as a full pass (D-95). Disclosed content appears only inside the untrusted block. `error` `NETWORK` when the public record does not answer.
- **`agentlink_status`**: `credits` `[{usd, advanced: {chain, token, amount}}]` (network and token names only under `advanced`, D-40), `prices` `[{action: "notarize", usd, protocolUsd, integratorUsd, payFrom: "credits"}]` (the AgentLink part and the app part shown separately, G-43), `agentAddress` and `topUpUrl`. Read within about 3 seconds; left out when no network answers.

## Outline (filled in at release)

- Per tool: purpose, input schema, output schema, annotations, status values, examples
- The untrusted-content format
- Server instructions sent at initialize
- The approval flow from a tool's point of view
- Changes between versions (from the changelog)

**Filled in at:** M1a (v0.1.0) and M1 (v0.2.0); backlog cards DOCS-M1a and DOCS-M1b.
