---
section: Added
---

- Desktop app updates, phase 1 (WP-D10, DESK-D10, S2, D-145 (5), 08 §8): the app trusts only updates signed with the owner's offline keys (a root key built in from the first build, and an update key it introduces, rotates or withdraws), checks the channel, this computer's system and chip, a strictly newer version, the expiry, the download host, and the installer's size and checksum, then offers "Open the installer". Nothing installs silently. Release builds refuse to build without the real root key. The owner's offline key setup and per-release signing: `docs/runbooks/desktop-update-keys.md`.
