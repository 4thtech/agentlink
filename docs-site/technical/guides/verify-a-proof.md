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

> **Status: in development (M1-4d, M1-4d-b).** The check below is built in `@4thtech-io/chain` (`verifyProofPack`) and is not user-facing yet; the CLI command and the tool arrive with M1-9h and M1-9d-2.

The pack is untrusted input. The verifier never echoes it: every failure is a fixed code with fixed plain-language text, and no RPC address or server text appears in a result.

**Reading the result.** The first field is `verdict`: `verified` (record, receipts and the disclosed content all check out, and the content is attributed to the signer; not reported while full sender attribution is in development), `record_only` (the record and receipts check out, but no content was disclosed, the content check failed, or the content is not tied to the signer; never shown as a full pass) or `failed` (the pack proves nothing, with a reason). `finality` says whether the record was read at a `finalized` block (no reorg can remove it) or only at `latest` (recent; it can still change).

1. **Size and shape.** At most 256 KiB. Strict JSON (no duplicate keys, whole numbers only) and the strict pack v1 schema: one spelling per value, nothing normalised. A shared content key without the message it opens, a key that is not exactly 32 bytes and a record type outside the six fixed ones (D-86) each have their own code.
2. **Network and contract.** The pack's `chainId` must be a network this release ships; the pack's contract address must equal the shipped proof contract for it. The verifier never reads an address or an RPC from the pack.
3. **Record ID.** Recomputed from the network, the contract, the signer and the nonce, as the contract does.
4. **`getRecord`.** Read at the `finalized` block where the network supports that tag, and again at `latest` when the record or a receipt the pack lists is newer than that block (or the network has no such tag); `finality` then says `latest`. The stored signer, record type, envelope hash, recipient commitment and the EIP-712 struct hash of all the record fields must equal the pack's. No event logs are read (some RPCs prune them).
5. **Signature.** As the contract checks it: a canonical ECDSA signature that recovers the signer, otherwise an ERC-1271 account at the signer address that accepts it (`isValidSignature` through a read call). A contract account is asked at verification time, so an account that has since changed its rules can answer differently than it did at inclusion. Only the ECDSA path requires the canonical form (low `s`, `v` 27 or 28); a 65-byte smart-account signature in another form (a Safe's `v` of 0, 1 or above 30) goes to the account. An empty or short answer from the account is a refusal. Planned (M1-4d-c, D-96): a contract account that refuses at verification time no longer fails the pack, because the Notary checked the signature when it stored the record; the result carries the non-fatal code `signer_no_longer_confirms` next to an unchanged verdict, with the text "The signer's account no longer confirms this record. The proof network checked it when the record was made."
6. **Agent profile (card), when the pack carries one.** Its owner signature (`cardSig`) must recover the card's owner address, the card's agent address must be the record signer and differ from its owner address, and the card must not have expired when the record was made (`expiresAt` 0 means no expiry). Otherwise the pack fails (`card_invalid`, `card_expired`). The card's display name and relays are not checked here, and the card's issue time is not compared with the record: a card reissued later with the same keys still binds them.
7. **Recipient and receipts.** A disclosed recipient and salt must open the commitment. Receipts are taken from the record's stored receipt times (`receiptAt`); each receipt the pack lists must be there, at the same second. The `receiptFlags` layout is now specified (05 §3.3, D-97: receipt type `t` sets bit `t − 1`); cross-checking it against `receiptAt`, with any mismatch reported as `malformed_record`, is planned (M1-4d-c). A receipt's `txHash` is not checked yet.
8. **Content (only with a shared content key), in this order, fail closed:** strict envelope parse; its hash equals the pack's and the record's; its signature verifies under its sender; with a card, that sender must be the card's agent key (`agentNostr`), otherwise `sender_mismatch` before the key is used; the key commitment matches the shared key (a key that opens a two-key ciphertext under AES-GCM but not the commitment is refused); decrypt; the strict message schema; then the message type must map to the record type (D-86). A failure here means the pack proves no content; the record and its receipts still verify. The result names the sender (the message's `from`). The content opens as `unattributed` and the verdict is `record_only`: without a card (`sender_not_bound`), the record proves that the signer notarized this message, not that the signer wrote it (a recipient can notarize a message it received); with a card that names the sender (`sender_attribution_pending`), full sender attribution is in development. Planned (M1-4d-d, 07 §8, D-102): the pack also carries the agent's signatures over its card (`cardAgentSig` from its EVM key and `cardPop` from its message key), made once per card and passed on in pairing and card updates, so a recipient-exported pack can carry them too; with both valid the verdict becomes `verified`, without them the content stays `unattributed` (`card_pop_missing`), and a forged signature or one taken from another card fails the pack (`card_pop_invalid`).

**Not checked here (yet).** The bytes of attached files: the check covers the message itself, and a file's integrity rests on the hashes inside that verified message (the file encryption is not key-committing). The owner's approval and receipt `txHash` are not checked yet (M1-4d-c). Full sender attribution is in development, so `verify` is not user-facing yet. The chain is read through one RPC; a dishonest RPC can claim a record or receipt that does not exist, so use your own RPC when it matters.

## Outline

- With the CLI: `agentlink verify <proof.json>` (v0.2.0)
- With the web page (v0.3.0): verification runs in your browser
- By hand, with any EVM library and a public RPC
- Reading the result: what it proves and what it does not
- Contract addresses: see [Contracts](../reference/contracts.md)

**Filled in at:** M1 (v0.2.0) and M2 (v0.3.0); backlog cards DOCS-M1b and DOCS-M2.
