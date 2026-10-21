---
'@4thtech-io/submitter': patch
'@4thtech-io/chain': patch
---

The submitter's chain port reads the Notary's `RecordNotFound()` revert from `getRecord` as "no such record", like the read client does. It used to treat that revert as an RPC error, so every new record made the submitter answer 503 `unavailable`. Any other `getRecord` revert is still an error.
