---
section: Fixed
---

- Verify: a proof pack whose record the chain does not hold now fails with "record not found" instead of "chain unavailable"; it still never verifies (CHORE-SUBMITTER-WRANGLER-DEV follow-ups, IR #338 L3, S2, 07 §8).
- Submitter: only the exact "record not found" answer from the chain counts as a new record; anything else stays a chain error (IR #338 L1, S2).
- Submitter: local `wrangler dev` starts again; the deployed Worker behaves the same (CHORE-SUBMITTER-WRANGLER-DEV, S2).
