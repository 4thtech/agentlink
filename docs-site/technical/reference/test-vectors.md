# Test vectors

> **Status: Planned for v0.1.0 (M1a)**, proof-layer vectors for v0.2.0 (M1). This page is an outline; the vectors are not published yet.

**Purpose:** reference for the shared, cross-runtime test vectors that every implementation (TypeScript packages, contracts, third parties) must pass.

## Outline

- Coverage: key derivation; BIP-340 envelope signatures; HPKE content key wrapping and payload AEAD; envelope hash (JCS); owner passphrase wrapping; pairing proof and safety code; agent card EIP-712 hash; `terms` and `termsHash` (v0.1.0)
- STREAM file encryption; EIP-712 `Record`, `Receipt`, `Registration`; passkey PRF wrapping; recovery code; drop request signatures (v0.2.0)
- File layout and how to consume the vectors from another language
- Which runtimes they run in (Node, browser, Workers) and in CI
- How a format change adds vectors

**Filled in at:** M1a (v0.1.0) and M1 (v0.2.0); backlog cards DOCS-M1a and DOCS-M1b.
