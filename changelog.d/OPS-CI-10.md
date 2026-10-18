---
section: Fixed
---

- CI's throwaway Linux keyring no longer needs a prompt when gnome-keyring restarts mid-run, which made the e2e tests fail at random with "the system keychain refused the request" (OPS-CI-10).
