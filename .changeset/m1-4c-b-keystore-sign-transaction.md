---
'@4thtech-io/crypto': minor
'@4thtech-io/chain': minor
'@4thtech-io/node': patch
---

`KeyStore.signTransaction` signs one direct-mode transaction with the agent's EVM key, on the launch testnets only: EIP-1559, to the AgentLink Notary, fee vault or an offered fee token, with a direct-mode call (`notarizeDirect`, `notarizeBatch`, `acknowledge`, `acknowledgeBatch`, `deposit`, `withdraw` to the agent's own address, `approve` of the vault), bounded value, calldata, gas and fees. Everything else is refused with `transaction_refused` before any key is read. The keychain KeyStore implements it. `@4thtech-io/chain` adds `keyStoreDirectSigner`, `createDirectMode` (testnets of the KeyStore allowlist only), the typed `buildWithdraw` and `sendWithdraw`, and the ChainError code `signing_refused`.
