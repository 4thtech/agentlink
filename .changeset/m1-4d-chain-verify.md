---
'@4thtech-io/chain': patch
---

M1-4d: `verifyProofPack(pack, {chains})` checks a proof pack (07 §8) against `getRecord` on the pack's supported chain and the shipped Notary: record ID, struct hash, signer, kind, envelope hash and commitment; the signature (canonical ECDSA, else ERC-1271 `isValidSignature`); a disclosed recipient; receipts from `RecordState`; and a disclosed content key in the 07 §8 order (G-46) with the D-86 kind check. A top-level `verdict` (`verified`, `record_only`, `failed`) and `finality` (`finalized`, else `latest`). Strict parsing (256 KiB cap, strict JSON, the types schema); fixed failure codes and messages (`PROOF_PACK_FAILURES`, `PROOF_CONTENT_FAILURES`, `proofFailureMessage`); `recordKindForPayload`.
