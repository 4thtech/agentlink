---
'@4thtech-io/chain': patch
'@4thtech-io/submitter': patch
---

M3-4b-t-T2-b: the gasless authorization builder now signs a window of at most 15 minutes (`GASLESS_MAX_WINDOW_SECONDS` = 900, was 3600), the same bound the relay checks (`validBefore` at most now + 900 + 120 s skew). Both relay checks read the one constant. Stale "until M1-3c" comments updated; a registry-level test covers the `GASLESS_TOPUP_ENABLED` kill switch.
