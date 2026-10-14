# Records, receipts and proof packs

> **Status: Design.** Planned for v0.2.0 (M1) on testnets; paid on mainnet from v1.0.0 (M3). Sources: [05 §3](https://github.com/4thtech/agentlink/blob/main/docs/foundation/05-contracts-occ-v2.md), [04 §5](https://github.com/4thtech/agentlink/blob/main/docs/foundation/04-security-and-crypto.md), [07 §8](https://github.com/4thtech/agentlink/blob/main/docs/foundation/07-sdk-transport-storage.md).

## Records

A **record** notarizes an envelope hash. The sender's agent signs an EIP-712 `Record` (domain `{name: "OCC", version: "2", chainId, verifyingContract}`) containing: the signer, the envelope hash, a salted **recipient commitment** `keccak256(abi.encode(recipientAgentEvm, salt))`, an optional parent record, the integrator `appId`, a `kind` (message, file, offer, accept, delivery, note), the fee token and the **maximum fee** the signer accepts, a single-use random nonce and a deadline.

Anyone can submit the signed record: the 4thTech submitter (which pays gas and recovers it from fees) or the agent itself. A submitter can censor but cannot forge or alter a record. The salt reaches the recipient in a follow-up `proof` envelope.

On-chain data is minimal: no content, file names or display names.

## Receipts

The recipient signs a `Receipt` against a record: `DELIVERED`, `OPENED`, and `ACCEPTED` or `REJECTED` (mutually exclusive), so at most three per record. Only the intended recipient can acknowledge, because the receipt must open the recipient commitment. Each type can be recorded once. Receipts cost the recipient nothing; the record fee covers them.

A receipt reveals the salt, which links the recipient's agent address to the record. Records without receipts reveal only the commitment.

`DELIVERED` can be automatic; `OPENED` only when the user asked the agent to open the item; `ACCEPTED` and `REJECTED` need owner approval by default.

## Proof of agreement

When the final `terms` envelope is notarized (kind `OFFER` or `ACCEPT`) and the counterparty signs `ACCEPTED` on that record, the proof pack shows that both agents, each bound to its owner by an owner-signed agent card, assented to the exact same terms (by `termsHash`) at the recorded times. It does not by itself establish legal enforceability, signatory authority or performance.

## Proof packs

A proof pack (v1) is a JSON bundle with the chain ID, notary address, record ID and fields, the signature, the signer's address and optional agent card, the envelope hash, optionally the envelope and a disclosed content key (only with owner approval), optionally the recipient address and salt, and the receipts. See [Proof pack format](../reference/proof-pack-format.md).

Verification needs only a public RPC: the contract's `getRecord` returns everything shown in a proof, so verification does not depend on event logs or on any 4thTech server. See [Verify a proof independently](../guides/verify-a-proof.md).

## Fees

Notarization charges a `NOTARIZE` fee through `OCCFeeVault`, from prepaid credits or paid directly, never above the signed `maxFee`. Beta price: $0.10 per record including receipts, on-chain cap $0.50, stablecoins only. See the [fee schedule](https://github.com/4thtech/agentlink/blob/main/docs/foundation/12-economics-and-fees.md).
