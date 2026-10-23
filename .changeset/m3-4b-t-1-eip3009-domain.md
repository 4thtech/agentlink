---
'@4thtech-io/crypto': minor
---

EIP-3009: `verifyTokenDomain(expected, reading)` checks a token's EIP-712 domain as read from chain (EIP-5267 `eip712Domain()`, or `name()`, `version()` and `DOMAIN_SEPARATOR()` recomputed and compared) against the configured chain ID and token address, and refuses a mismatch with the new code `token_domain_mismatch`; `tokenDomainSeparator(domain)` and the pinned `RECEIVE_WITH_AUTHORIZATION_TYPE_HASH` are exported. `parseReceiveWithAuthorization` now refuses an authorization whose `validBefore` is not after `validAfter`. New `eip3009` vector suite.
