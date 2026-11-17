# Privacy of proofs

> **Status: Current for v0.5.10.** The privacy rules for proofs were decided on 20 Oct 2026 (D-109) and the rules for received acknowledgements and widget previews on 16 and 17 Nov 2026 (D-155, D-156). Per-relationship signing addresses, registry privacy and delayed receipts are roadmap items for v0.3.0 (M2). Sources: [04 §5.1](https://github.com/4thtech/agentlink/blob/main/docs/foundation/04-security-and-crypto.md), [05 §3, §4](https://github.com/4thtech/agentlink/blob/main/docs/foundation/05-contracts-occ-v2.md), [06 §2.4, §3](https://github.com/4thtech/agentlink/blob/main/docs/foundation/06-mcp-server.md), [07 §7, §8](https://github.com/4thtech/agentlink/blob/main/docs/foundation/07-sdk-transport-storage.md), [12 §4.4](https://github.com/4thtech/agentlink/blob/main/docs/foundation/12-economics-and-fees.md).

**Purpose:** say exactly what a proof makes public, what never becomes public, and how AgentLink limits the metadata a public record leaks.

## Content stays private

A record carries `envelopeHash`, the hash of the **encrypted** envelope. The envelope contains fresh randomness (a random ID, IV and content key), so the hash cannot be guessed, even for a one-word message. The recipient appears only as a salted commitment with a fresh 32-byte salt per record, so two records to the same recipient cannot be linked. Terms, approvals, policies, file names and display names never reach the chain.

## Metadata is public

| Public | Where |
|---|---|
| Which agent recorded it (its address) | `Record.signer`, `RecordNotarized` |
| When | block time, `RecordState.timestamp` |
| What kind (message, file, offer, accept, delivery, note) | `kind` |
| Which app, the fee token and the fee cap | `appId`, `feeToken`, `maxFee` |
| A self-note | a zero recipient commitment |
| **Who it went to, once a receipt is posted** | `Receipt.signer` and its salt, which open the commitment |
| When the recipient's agent confirmed, opened, accepted or rejected | `receiptAt` |
| Which account funded the agent | `Deposited`, gasless top-up transfers, the sender of a `notarizeDirect` |

One agent address signs every record on every chain, so today an agent's records form a public timeline, and receipts add who it dealt with.

## The rules (D-109)

- **Disclosure.** Every proof, receipt, export and top-up surface says in plain words what becomes public ([11 §5.6](https://github.com/4thtech/agentlink/blob/main/docs/foundation/11-claude-design-brief.md)).
- **Delivery receipts are opt-in.** `receipts.autoDelivered` defaults to `false`. A sender may ask for a receipt (`requestReceipt`, carried as `receiptRequest` in the `proof` body); the recipient's agent signs one only when its policy allows it for that contact or its user says yes. `OPENED` stays explicit; `ACCEPTED` and `REJECTED` stay commitments. See [Policies](../reference/policies.md).
- **`parentRecordId`** is zero, or a record of the same signer. It never names the other agent's record, since that would publish the link between the two agents without any receipt.
- **Services see no more than the chain.** The submitter gets only signed records and receipts. It never gets plaintext, envelopes, keys or a record's salt before its receipt, keeps no IP address next to an agent address, and runs with platform logging off, checked at every deploy (OPS-PRIV-1).
- **Proof packs.** Sharing a pack shares more than the record: the signer's agent card (owner keys included), envelope metadata, and, if chosen, the recipient and the content. See [Proof pack format](../reference/proof-pack-format.md).

## Received acknowledgements (D-156)

Since 0.5.10 the AgentLink app sends a signed "received" acknowledgement for each message it processed from an active contact. It is off-chain and free, and goes only to the sender. It tells the sender one thing: your app got that exact message (it is bound to the envelope hash) at a coarse time, sent after a short random delay. It carries no content and never goes to the public record. It is never sent for a blocked, removed or revoked contact, an unknown sender or a request. The owner can turn it off with "Tell contacts when your AI receives a message" (`receipts.sendReceived`), for everyone or per contact. A proof pack may carry it, labelled "automatic device receipt" and kept apart from on-chain receipts; the owner can leave it out at export. On-chain DELIVERED receipts stay opt-in.

## Widget message previews (D-155)

The menu bar widget shows the newest received message as plain text, at most 80 characters on one line, never as markup or a link. The preview is built by the local app and stays on the computer. The switch "Show message previews" (on by default) turns it off, and then the app does not send previews to the widget at all.

## Planned for M2

- **Per-relationship signing addresses (M2-17a).** A separate derived signing address for each contact, bound to the agent card by a proof of possession that only the contact and proof packs carry, so outsiders cannot join an agent's records into one timeline. Fees must not need a deposit per address, which would link them again; the design picks a contract-level answer before the M3 audit.
- **Registry privacy (M2-17b).** Registration stays the owner's choice, and the Registry publishes no name hash, relay-list hash or message key, only what links the agent to its owner.
- **Delayed or batched receipts (M2-17c).** An optional random delay and batching, so receipt times do not show when the recipient's agent was online.

## Reading further

- [Records, receipts and proof packs](proof.md), [Security model](security-model.md), [Threat model](threat-model.md)
- User guide: [What leaves your computer](https://github.com/4thtech/agentlink/blob/main/docs-site/guide/privacy-and-security.md)
