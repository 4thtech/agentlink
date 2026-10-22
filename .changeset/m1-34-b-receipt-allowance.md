---
'@4thtech-io/submitter': patch
'@4thtech-io/chain': patch
'@4thtech-io/core': patch
---

Receipts covered by the sender's proof fee (M1-34-b, D-114). The submitter accepts up to 3 receipts for a record the Notary stores (its NOTARIZE fee was charged), whatever the recipient holds: one `getRecord` read per record before simulation; a receipt for an unknown record is `failed` with `RecordNotFound`, a new type over the cap (on-chain plus in flight) with `receipt_limit`, and ACCEPTED against REJECTED in flight with `ConflictingReceipt`. The chain port gains `recordReceipts` and `MAX_RECEIPTS_PER_RECORD`. `createProofSubmitter` never sends a receipt in direct mode unless `directReceipts: true`, so the recipient's own account never pays for it unasked; a receipt no submitter takes is `pending`. `ProofSubmitter.acknowledge` takes an optional per-call `waitMs`. The core posts queued receipts (`postQueuedReceipts`, at most 5 per pass, least recently tried first, 2 s wait each) after each sync pass's new envelopes, the same signed bytes until they land; a receipt the chain refuses for good (`RecordNotFound`, `InvalidSignature`, `NotRecipient`) becomes `receipt_failed` and is not retried.
