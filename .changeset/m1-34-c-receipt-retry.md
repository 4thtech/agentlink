---
'@4thtech-io/core': patch
---

A receipt that the client's chain reads answer `RecordNotFound` for is posted again once, with the same signed bytes, after a fixed 3 s (`RECEIPT_NOT_FOUND_RETRIES`, `RECEIPT_NOT_FOUND_RETRY_MS`) before it becomes `receipt_failed` (M1-34-c), so an RPC that lags behind the record's block does not fail the receipt for good. `ProofsPlatform` takes an optional `sleep` for that delay.
