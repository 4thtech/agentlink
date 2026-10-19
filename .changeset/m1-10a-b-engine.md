---
'@4thtech-io/chain': patch
'@4thtech-io/submitter': patch
---

M1-10a-b: the submitter's chain port adds `latestNonce()` (mined transactions only). The submitter resubmits a shared revert with no identifiable cause split per signer, reconciles a given-up transaction against the `latest` nonce so no nonce is skipped, and keeps an item in flight when the chain cannot be read while re-simulating it after a revert.
