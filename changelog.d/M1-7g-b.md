---
section: Added
---

- The recipient of a recorded message can now export its own proof pack too (M1-7g-b, S2, D-107, 07 §8): the sender's proof message carries the signed record, which the recipient checks against the proof network and its copy of the message before keeping it. A check that cannot reach the proof network waits and retries for up to 7 days instead of being refused. A proof from an older sender is still accepted, but its recipient cannot export a pack.
