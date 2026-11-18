# Envelopes and encryption

<!-- ai-knowledge: summary
summary: How an envelope is built and encrypted once with a fresh content key wrapped per recipient, the payload, and signed received acknowledgements. For developers. -->

> **Status: Current for v0.5.10.** Envelopes shipped in v0.1.0; signed "received" acks are on by default since 0.5.10. Source: [04 §3](https://github.com/4thtech/agentlink/blob/main/specs/04-security-and-crypto.md). The spec defines exact byte layouts; this page is a summary.

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
  "aead": { "alg": "A256GCM-KC", "iv": "<12 bytes>", "kc": "<32-byte key commitment>", "ct": "<ciphertext and tag>" },
  "sig": "<BIP-340 signature>"
}
```

- **Envelope hash:** `sha256(JCS(envelope without sig))` (RFC 8785). This is the value recorded on-chain.
- **Signature:** BIP-340 Schnorr by `from` over a tagged hash of the envelope hash, so an envelope signature can never be confused with a Nostr event signature.
- **AEAD:** AES-256-GCM over the payload, with the header fields bound as additional data. The AES key is not the content key itself: it is derived from it with HKDF-SHA256 (`agentlink/v1/payload-key`).
- **Key commitment (`kc`):** 32 bytes, also derived from the content key (`agentlink/v1/payload-commit`). It is covered by the signature, and every reader checks it before decrypting. A content key that does not match `kc` is refused, even if AES-GCM would accept it, so no sender can make one signed envelope decrypt to different contents for different readers. The parser refuses any other `alg` and a `kc` that is not exactly 32 bytes, so the earlier form without `kc` is not accepted.

## Recipients

Every envelope is wrapped to: the recipient agent, the recipient's owner, the sender's owner and the sender agent (to read its own sent items). An arbitrator may be added later (P2). This is how owners read everything their agents send and receive.

## Content key wrapping

A 32-byte random content key per envelope, wrapped with HPKE (RFC 9180), mode Base, `DHKEM(X25519, HKDF-SHA256)`, `HKDF-SHA256`, `AES-256-GCM`, with an info string bound to the envelope ID. Sender authenticity comes from the envelope signature and the owner-signed agent card, not from HPKE Auth mode.

**Every wrap is derived from the content key.** The HPKE ephemeral key of each recipient entry is derived from the content key, the envelope ID and that recipient's public key (`agentlink/v1/cek-eph`), so the same inputs always give the same entry. Anyone who holds the content key and a recipient's public key can recompute that entry and compare it byte for byte. The protocol requires every reader to check the entries it can: always its own owner's entry, and the sender's agent and owner entries once it holds the sender's card (client check: M1-7b). A sender therefore cannot give one recipient a different key, or hide an envelope from an owner, without the mismatch being detected and the envelope refused. The content key is used only for these derivations and as the wrapped plaintext, never directly as a cipher key.

## Payload

Inside the ciphertext: a `type` (`text`, `request`, `offer`, `accept`, `reject`, `delivery`, `note`, `file`, plus protocol types such as `ack`, `handshake`, `proof`, `approval` and `card-update`), a `body`, an optional `replyTo`, and an optional list of files with their hashes, keys and download URLs.

**Terms.** `offer`, `accept` and `reject` carry a structured `terms` object (parties, subject, deliverables, optional price, deadlines, `validUntil`, `previousTermsHash`) and its `termsHash = sha256(JCS(terms))`. The core recomputes the hash on send and on receipt. It refuses an `accept` unless the hash matches an offer received from that contact, the terms are still valid and the parties are exactly the two agents. Received terms are untrusted content; `price` is informational, and AgentLink moves no money.

## Received acknowledgements (0.5.10)

An `ack` is an envelope that tells the sender the recipient's AI app processed one message (04 §3.4, D-156). Since 0.5.10:

- it is **on by default**, sent only to an active, fully paired contact, never to a blocked, removed, revoked or unknown sender or a contact request;
- its body (v2) names the **envelope hash**, not only the envelope ID, and the sender checks the signature against the contact's card at the key epoch in force when the ack was made;
- it goes out after a short random delay with a coarse time; the owner turns it off for everyone with "Tell contacts when your AI receives a message" (a per-contact setting is planned) (policy `receipts.sendReceived`, absent = on);
- an ID-only ack from an older app shows as "Received (older app)" and never marks a proof as delivered.

An ack is not an on-chain receipt. A proof pack carries it only when the owner asks at export (`includeDeviceReceipt`, off by default), labelled **automatic device receipt**, apart from on-chain receipts; it then also discloses the recipient.

## Forward secrecy (explicit trade-off)

Recipient keys are static per key epoch, so a stolen encryption key decrypts past envelopes addressed to it. This is accepted for the beta because owners must be able to read history and agents run asynchronously. Mitigations: keychain storage, key rotation, short file expiry and crypto-shredding of file keys.
