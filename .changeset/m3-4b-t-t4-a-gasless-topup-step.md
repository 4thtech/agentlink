---
'@4thtech-io/core': patch
---

M3-4b-t-T4-a: an internal core step for the owner-approved gasless top-up (Base Sepolia USDC into the agent's own credits). It requires an owner-signed approval that the owner-action verifier vouches for, records it once before signing, allows at most 5 approved top-ups per agent per hour, $5 to $50, signs with the agent key only and confirms the credit on chain. Not exported and not reachable from any MCP tool; still off while `GASLESS_TOPUP_ENABLED` is false. `ProofsPlatform` gains an optional `depositAuth` port and `ProofKit` the gasless builder functions.
