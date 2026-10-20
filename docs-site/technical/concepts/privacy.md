# Privacy of proofs

> **Status: Design.** The privacy rules for proofs were decided on 20 Oct 2026 (D-109) and are not built yet: delivery receipts off by default, the disclosure wording and the record-linking rule are planned for v0.2.0 (M1); per-relationship signing addresses, registry privacy and delayed receipts for v0.3.0 (M2). Sources: [04 §5.1](https://github.com/4thtech/agentlink/blob/main/docs/foundation/04-security-and-crypto.md), [05 §3, §4](https://github.com/4thtech/agentlink/blob/main/docs/foundation/05-contracts-occ-v2.md), [06 §2.4, §3](https://github.com/4thtech/agentlink/blob/main/docs/foundation/06-mcp-server.md), [07 §7, §8](https://github.com/4thtech/agentlink/blob/main/docs/foundation/07-sdk-transport-storage.md), [12 §4.4](https://github.com/4thtech/agentlink/blob/main/docs/foundation/12-economics-and-fees.md).

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

## Planned for M2

- **Per-relationship signing addresses (M2-17a).** A separate derived signing address for each contact, bound to the agent card by a proof of possession that only the contact and proof packs carry, so outsiders cannot join an agent's records into one timeline. Fees must not need a deposit per address, which would link them again; the design picks a contract-level answer before the M3 audit.
- **Registry privacy (M2-17b).** Registration stays the owner's choice, and the Registry publishes no name hash, relay-list hash or message key, only what links the agent to its owner.
- **Delayed or batched receipts (M2-17c).** An optional random delay and batching, so receipt times do not show when the recipient's agent was online.

## Reading further

- [Records, receipts and proof packs](proof.md), [Security model](security-model.md), [Threat model](threat-model.md)
- User guide: [What leaves your computer](https://github.com/4thtech/agentlink/blob/main/docs-site/guide/privacy-and-security.md)
