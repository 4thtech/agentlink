---
'@4thtech-io/chain': patch
'@4thtech-io/node': patch
---

M1-4b: fee quotes in USD (`quoteFee`: the vault's `quote` with the protocol and integrator parts, 1:1 for the stablecoin fee tokens, fail-closed when the parts do not add up), credits per chain and across chains (`readCredits`, `readCreditsAcrossChains`), the direct-mode deposit helper (`buildDeposit`: exact-amount approve, then deposit; sends nothing) and the credit event filter (`filterCreditEvents`, `readCreditHistory`: canonical vault only, zero-amount events ignored). Only offered allowlisted fee tokens are priced, shown or deposited. The read client is now a frozen view of the viem client: `extend` stays wrapped, namespaced actions and `onError` callbacks get URL-free `ChainError`s, and the transport exposes no RPC URL. `createReadClient` accepts only the address-checked fetch; `@4thtech-io/node` `nodeRpcFetch` carries that brand.
