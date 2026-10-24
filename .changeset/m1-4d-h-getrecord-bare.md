---
'@4thtech-io/chain': patch
---

The read client's `getRecord` returns "no such record" only when the revert data is exactly the `RecordNotFound()` selector; the same selector with trailing bytes, an `Error(string)` naming it, or an empty revert stays a `call_reverted` failure, so no replacement proof is decided on it (M1-4d-h).
