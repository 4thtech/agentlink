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
  "envelope": { /* optional ciphertext envelope */ },
  "recipient": { "evm": "0x…", "salt": "0x…" },          // optional disclosure
  "receipts": [ { "type": "DELIVERED", "signer": "0x…", "txHash": "0x…", "at": "…" } ],
  "disclosure": { "contentKey": "base64url" } | null,  // only if the owner approved
  "exportedAt": "…"
}
```

## Outline (filled in at v0.2.0)

- Field-by-field reference and JSON Schema
- What each optional disclosure reveals, and who approves it
- Proof of agreement packs
- Compatibility rules: readers accept every pack version ever issued

**Filled in at:** M1 (v0.2.0), backlog card DOCS-M1b.
