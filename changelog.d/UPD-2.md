---
section: Changed
---

- The owner's update key is pinned (UPD-2, S2, D-151): `root-key.json` now holds the public key `7efc699d…c984` (the private part is the `desktop-update` environment secret) and release builds are made with updates on, so 0.5.4 can check for and install signed updates. Copies from 0.5.2 and earlier never check, so everyone installs 0.5.4 by hand once.
