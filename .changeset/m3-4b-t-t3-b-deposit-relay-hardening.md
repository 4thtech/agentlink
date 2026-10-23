---
'@4thtech-io/submitter': patch
---

`POST /v1/deposit-authorization` hardening (still off by default): refuses `unavailable` and sends nothing while more than 3 relay transactions are pending (counter `deposit_relay_stuck`); a global hourly cap `SUBMITTER_DEPOSIT_AUTH_REQUESTS_PER_HOUR` (default 200); a failed send gives the agent's hourly count back; each authorization is recorded before it is sent, so a crash mid-send never resends it; `bad_request` and `too_large` now answer `{status: "failed", error}` like every other refusal of the route.
