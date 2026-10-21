---
'@4thtech-io/submitter': patch
'@4thtech-io/chain': patch
---

The submitter's chain port now sends its RPC requests with `redirect: "manual"`. The Workers runtime refuses `redirect: "error"` with a TypeError, so every RPC call failed and `/v1/health` reported each chain unavailable. A redirect is still never followed: a 3xx answer moves to the next RPC URL.
