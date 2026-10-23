---
'@4thtech-io/node': minor
---

M1-8f (D-54, 04 §2.8): the passphrase-locked file KeyStore for headless machines, opt-in only. `createFileKeyStoreAgent` creates an agent in `~/.agentlink/keystore/<agentId>.alks` only when the OS keychain probe fails, from an interactive terminal with no AI-app marker set, with a generated unlock code by default. `unlockFileKeyStoreAgent` reads the unlock secret from `AGENTLINK_KEYSTORE_PASSPHRASE_FILE`, then `AGENTLINK_KEYSTORE_PASSPHRASE` (both removed from the environment), then an optional prompt, and keeps only the derived key in memory. `changeFileKeyStorePassphrase` re-wraps the file under a new secret. `openAgentKeyStore` and `openAgentStore` take the unlocked handle as `fileAgent` for the recorded backend `file`. The policy-version mark and the receipts-kept marker are `ALKS` entries written with the 04 §2.8 write protocol. Nothing changes for keychain agents.
