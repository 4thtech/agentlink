---
'@4thtech-io/chain': patch
'@4thtech-io/node': patch
---

M1-4a: the chain client foundation. A supported-chain registry composed from the shipped network entries and the pinned `@4thtech-io/occ-v2-abi` release (Base Sepolia today), automatic testnet-only chain selection, an RPC URL rule (04 §4: https, public host name, no key), a read-only viem client per chain with a fallback transport, timeouts and retries, calls encoded only from the client-safe ABIs, `Record`, `Receipt` and `AgentCard` builders with EIP-712 vector parity and signing through `KeyStore.sign712`, a fresh CSPRNG salt and nonce for every Record, and the Notary's record ID derivation. Read-client errors are fixed-code `ChainError`s with no RPC URL. `@4thtech-io/node` adds `nodeRpcFetch`, the RPC fetch that refuses private and loopback addresses at resolve time and pins the checked address per request (04 §4).
