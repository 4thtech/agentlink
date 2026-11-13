---
section: Changed
---

- Desktop updates, format v2 (UPD-1, S2, 08 §8): one update key, pinned in the app (owner decision 2026-11-13: no offline root key and no key statements; a new key arrives with a release that pins it). Manifests carry `channel`, `expires` and an asset `kind` (`dmg`, `zip`, `nsis`) under the new `agentlink-desktop-update/v2` tag; v1 documents are refused as an old format. A version that failed to start is recorded and never offered again. The Mac app now asks for its build's channel instead of always `stable`, and an Intel copy under Rosetta asks for the Apple silicon build. Updates stay off in release builds until the key is pinned. Shared test vectors: `test-vectors/desktop-update`.
