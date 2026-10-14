# Envelopes and encryption

> **Status: Design.** Planned for v0.1.0 (M1a). Source: [04 §3](https://github.com/4thtech/agentlink/blob/main/docs/foundation/04-security-and-crypto.md). The spec defines exact byte layouts; this page is a summary.

An **envelope** is the container for every message and file reference. It is encrypted once with a fresh content key, and that key is wrapped separately for each recipient.

## Structure (v1)

```jsonc
{
  "v": 1,
  "id": "<16 random bytes>",
  "thread": "<16 bytes, stable per conversation>",
  "from": "<sender agent Nostr x-only pubkey>",
  "createdAt": 1760000000,
  "recipients": [ { "kid": "...", "enc": "<HPKE encapsulated key>", "wk": "<wrapped content key>" } ],
  "aead": { "alg": "A256GCM", "iv": "<12 bytes>", "ct": "<ciphertext and tag>" },
  "sig": "<BIP-340 signature>"
}
```

- **Envelope hash:** `sha256(JCS(envelope without sig))` (RFC 8785). This is the value recorded on-chain.
- **Signature:** BIP-340 Schnorr by `from` over a tagged hash of the envelope hash, so an envelope signature can never be confused with a Nostr event signature.
- **AEAD:** AES-256-GCM over the payload, with the header fields bound as additional data.

## Recipients

Every envelope is wrapped to: the recipient agent, the recipient's owner, the sender's owner and the sender agent (to read its own sent items). An arbitrator may be added later (P2). This is how owners read everything their agents send and receive.

## Content key wrapping

A 32-byte random content key per envelope, wrapped with HPKE (RFC 9180), mode Base, `DHKEM(X25519, HKDF-SHA256)`, `HKDF-SHA256`, `AES-256-GCM`, with an info string bound to the envelope ID. Sender authenticity comes from the envelope signature and the owner-signed agent card, not from HPKE Auth mode.

## Payload

Inside the ciphertext: a `type` (`text`, `request`, `offer`, `accept`, `reject`, `delivery`, `note`, `file`, plus protocol types such as `handshake`, `proof`, `approval` and `card-update`), a `body`, an optional `replyTo`, and an optional list of files with their hashes, keys and download URLs.

**Terms.** `offer`, `accept` and `reject` carry a structured `terms` object (parties, subject, deliverables, optional price, deadlines, `validUntil`, `previousTermsHash`) and its `termsHash = sha256(JCS(terms))`. The core recomputes the hash on send and on receipt. It refuses an `accept` unless the hash matches an offer received from that contact, the terms are still valid and the parties are exactly the two agents. Received terms are untrusted content; `price` is informational, and AgentLink moves no money.

## Forward secrecy (explicit trade-off)

Recipient keys are static per key epoch, so a stolen encryption key decrypts past envelopes addressed to it. This is accepted for the beta because owners must be able to read history and agents run asynchronously. Mitigations: keychain storage, key rotation, short file expiry and crypto-shredding of file keys.
