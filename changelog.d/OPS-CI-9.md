---
section: Fixed
---

- CI waits for the Linux keyring to answer before the keychain and e2e tests start, so a slow gnome-keyring no longer fails them at random (OPS-CI-9).
