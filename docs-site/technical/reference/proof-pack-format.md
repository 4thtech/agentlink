# Proof pack format

> **Status: Design.** Planned for v0.2.0 (M1). The draft below is from [07 §8](https://github.com/4thtech/agentlink/blob/main/docs/foundation/07-sdk-transport-storage.md) and may change before release. Once released, every pack version stays readable forever.

```jsonc
{
  "type": "agentlink.proof",
  "version": 1,
  "chainId": 8453,
  "notary": "0x…",
  "recordId": "0x…",
  "record": { /* Record struct fields */ },
  "signature": "0x…",
  "signer": { "evm": "0x…", "agentCard": { /* optional, signed by the owner */ } },
  "envelopeHash": "0x…",
  "envelope": { /* ciphertext envelope; optional, but required whenever disclosure is non-null */ },
  "recipient": { "evm": "0x…", "salt": "0x…" },          // optional disclosure
  "receipts": [ { "type": "DELIVERED", "signer": "0x…", "txHash": "0x…", "at": "…" } ],
  "disclosure": { "contentKey": "base64url" } | null,  // only if the owner approved; the 32-byte content key
  "exportedAt": "…"
}
```

## Disclosed content key

A pack that discloses a content key lets any verifier read the one plaintext that every party to the envelope read.

- When `disclosure` is present, `envelope` must be present too, or the pack is rejected. `contentKey` is the envelope's 32-byte content key, never the derived payload key; any other length is rejected.
- A verifier checks, in this order, and stops at the first failure: parse the envelope strictly; recompute `envelopeHash` and match it against the pack and the on-chain record; verify the envelope signature; derive the key commitment from `contentKey` and compare it with `aead.kc`; decrypt; apply the payload schema.
- A key that fails the commitment check is rejected, even if AES-GCM would accept it. A pack that fails any step proves no content; its record and receipts are still verified on their own.
- Optionally, a verifier that also holds the counterparty's card can recompute that party's recipient entry from the disclosed key, to confirm it carried the same key.

## Outline (filled in at v0.2.0)

- Field-by-field reference and JSON Schema
- What each optional disclosure reveals, and who approves it
- Proof of agreement packs
- Compatibility rules: readers accept every pack version ever issued

**Filled in at:** M1 (v0.2.0), backlog card DOCS-M1b.
