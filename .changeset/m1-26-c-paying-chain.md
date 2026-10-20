---
'@4thtech-io/agentlink': patch
---

M1-26-c: `agentlink_status` prices and credits follow the same automatic selection as the paid tools (07 §6.3, D-40). The notarize price is the one where the next proof would be paid: the funded chain's, or, with no credits anywhere, the chain a top-up goes to. The paying chain's credits are listed first, and the owner's default proof network applies to status as it does to `agentlink_notarize`. Network names stay under `advanced` (D-108).
