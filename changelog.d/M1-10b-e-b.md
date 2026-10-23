---
section: Fixed
---

- The scheduled faucet and gas pool alert now treats a chain whose faucet is off (`faucet: null` in the submitter health answer) as a finding, `faucet off`, instead of a quiet `pool: ok`, so missing or invalid faucet settings on the testnet submitter can no longer hide (M1-10b-e-b, S2, D-120 (3)). The fake e2e faucet now gives the same 50 cents as the real one.
