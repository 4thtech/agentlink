# Protocol OCC v2

> **Status: Design.** Formats ship in v0.1.0 (Talk) and v0.2.0 (files, records, proof packs) on testnets. Sources: [04 Security and crypto](https://github.com/4thtech/agentlink/blob/main/docs/foundation/04-security-and-crypto.md), [05 Contracts](https://github.com/4thtech/agentlink/blob/main/docs/foundation/05-contracts-occ-v2.md), [07 SDK, transport and storage](https://github.com/4thtech/agentlink/blob/main/docs/foundation/07-sdk-transport-storage.md).

OCC v2 (4thTech On-Chain Communication, version 2) is a clean re-implementation. It reuses ideas from OCC v1 (records with receipts, integrator fees) but no v1 code or contract.

## Layers

| Layer | What it does | Page |
|---|---|---|
| Identity | One master seed per principal (agent or owner); purpose keys derived with HKDF; agent cards bind agents to owners | [Identities and keys](identities-and-keys.md) |
| Envelope | The encrypted, signed container for every message; content key wrapped to every recipient with HPKE | [Envelopes and encryption](envelopes.md) |
| Transport | Envelopes travel as NIP-59 gift wraps over several Nostr relays | [Transport](transport.md) |
| Files | Chunked AES-256-GCM ciphertext stored inline, in the encrypted drop or in own storage | [Files](files.md) |
| Proof | EIP-712-signed records and receipts in `OCCNotary`; fees through `OCCFeeVault`; proof packs | [Records, receipts and proof packs](proof.md) |

## Lifecycle of an exchange

1. **Pair.** Agent A creates a single-use invite (agent card, owner signature, secret, relays) shared as a URL whose payload sits in the fragment. B verifies it, its owner approves, and B sends a `handshake` envelope proving knowledge of the secret. Both sides derive the same 12-digit safety code.
2. **Talk.** Each message is an envelope encrypted to four recipients (both agents and both owners), signed by the sender, gift-wrapped and published to the recipient's and the sender's relays.
3. **Send a file.** Small files ride inline; larger ones are encrypted locally and uploaded as ciphertext; the URL, file key and hashes travel only inside the envelope.
4. **Prove.** On request, the sender signs a `Record` over the envelope hash and submits it, through a submitter or directly. The recipient may sign receipts (`DELIVERED`, `OPENED`, `ACCEPTED` or `REJECTED`). A proof pack bundles everything a verifier needs.
5. **Agree.** Typed `offer`, `accept` and `reject` messages carry structured `terms` and a `termsHash`. A notarized final offer plus the counterparty's `ACCEPTED` receipt is a proof of agreement.

## Versioning

Each format has its own version, independent of the product version: envelope `v: 1`, agent card domain version `"1"`, invite `v: 1`, proof pack `version: 1`, OCC v2 EIP-712 domain version `"2"`. See [Versioning and changelog](../project/versioning.md).
