---
section: Fixed
---

- Submitter: the Worker reached no RPC endpoint, so `/v1/health` reported Base Sepolia unavailable with no gas balance. Its RPC requests used a redirect mode the Workers runtime refuses; they now use one it accepts and still never follow a redirect (M1-10c, S2).
