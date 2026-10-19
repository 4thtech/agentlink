---
'@4thtech-io/chain': patch
---

M1-4d-c: `verifyProofPack` cross-checks `receiptFlags` with `receiptAt` (D-97: type `t` is bit `t − 1`, bits 4–7 zero, ACCEPTED and REJECTED never both; any mismatch is `malformed_record`); reports a contract-account signer whose `isValidSignature` no longer accepts the pack's signature with the non-fatal notice `signer_no_longer_confirms`, the verdict unchanged (D-96); checks each listed receipt's `txHash` with one transaction-receipt read (`receipts[].tx`: `confirmed`, `not_checked` or `mismatch`, the last with the non-fatal notice `receipt_tx_mismatch`); and checks the pack's signed owner approval against the record and the signer's card (`ownerApproval`; an invalid one fails with `owner_approval_invalid`), or reports a standing rule's policy hash. New result fields: `notices`, `ownerApproval`, `receipts[].tx`.
