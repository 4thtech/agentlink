---
'@agentlink/crypto': minor
---

Add the `KeyStore` and `OwnerKeyStore` interfaces (types in the main entry, so transport and core can name them): no method returns a private key or a seed, envelope-hash signing and decryption epochs are included (G-2), and owner signatures exist only on a short-lived session from `unlock(presence)`, which expires and is wiped on lock. Add NIP-44 v2 through `@noble` with strict size, version, base64, MAC and padding checks, Nostr event ids and verification, and a NIP-59 gift wrap whose ephemeral key never leaves the package. `MemoryKeyStore` and `MemoryOwnerKeyStore` (tests and development only, not for production) and the NIP-44 functions that take a secret or conversation key are exported only from `@agentlink/crypto/keystore`. EIP-712 signing and HPKE opening are declared on the interfaces and fail closed until their tasks land.
