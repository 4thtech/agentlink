---
section: Added
---

- Spec and crypto for approving with Touch ID or Windows Hello in the desktop app (DESK-D12a, S2, 04 §2.3.4): the owner key can also be sealed as `ALKH` v1 under a secret the desktop presence helper releases after the gesture, bound to the helper credential, its per-install peer key or challenge and the owner key. Not wired into the app yet; while builds are unsigned it is as strong as the passkey path, not stronger.
