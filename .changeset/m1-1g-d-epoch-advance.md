---
'@agentlink/crypto': minor
'@agentlink/core': minor
---

Add owner-only key rotation. `@agentlink/crypto` adds the `KeyEpochControl` interface, a management surface kept apart from the agent's `KeyStore`, so the agent path cannot move the key epoch. `previewEpoch(n + 1)` returns the next epoch's public keys without advancing; until the advance, signing and decryption at that epoch stay unavailable. `advanceEpoch(expected, ownerSession)` is a compare-and-set: it needs a live owner session, and it fails with the new `epoch_conflict` code, changing nothing, unless the store is at `expected`. Older epochs still decrypt. The in-memory test KeyStore implements both. In `@agentlink/core`, `identity.rotate` takes the control from the owner flow. It signs the next card, stores it as pending (new `identity.pending_card_json` column), advances the KeyStore, and then commits the new epoch. When the client opens, an owner-signed pending card for exactly the KeyStore's keys finishes an interrupted rotation. Without one, the agent refuses to send until the owner rotates again.
