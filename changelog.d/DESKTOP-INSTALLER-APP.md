---
section: Added
---

- DESKTOP-INSTALLER-APP (S2, 08 §4, §8): the one-line installer gets a desktop app mode, `--desktop` (Mac) and `-Desktop` (Windows), switched off until the desktop app is released. Once on, it downloads the app from the AgentLink GitHub Release, checks it against the release's SHA256SUMS and the hash in the installer, and installs it for you only (`~/Applications`, or the per-user setup on Windows), so an early Mac build is not blocked as "damaged". It never removes quarantine marks or changes Gatekeeper or SmartScreen. Today's installer is unchanged.
