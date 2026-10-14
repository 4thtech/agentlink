---
'@agentlink/chain': patch
---

Adds the launch-testnet chain configuration: Base Sepolia with Circle's USDC, and Gnosis Chiado with xDAI. Also adds the USD fee schedule ($0.10 per proof with a $0.50 cap, $5 per registration with a $25 cap, $5 minimum deposit) and a config check. The check accepts only USD stablecoins, allows the native coin only on Gnosis, requires a source for every entry and accepts only keyless public RPC URLs with a host. Each chain also records whether it answers the `finalized` block tag.
