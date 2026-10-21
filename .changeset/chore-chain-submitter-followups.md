---
'@4thtech-io/chain': patch
'@4thtech-io/submitter': patch
---

The submitter's chain port reads a `getRecord` revert as "no such record" only when its data is exactly the `RecordNotFound()` selector; revert data with trailing bytes stays an RPC error. The proof-pack verifier now reports a `RecordNotFound()` revert as `record_not_found` instead of `chain_unavailable`; any other revert is still `chain_unavailable`, and a missing record never verifies. The submitter's Worker entry module exports only the fetch handler and its Durable Object classes, so local `wrangler dev` starts; the package's shared exports move to `lib.ts`.
