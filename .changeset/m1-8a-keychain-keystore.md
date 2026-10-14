---
'@agentlink/node': minor
---

Add the OS keychain KeyStore: the agent's keys on macOS Keychain, Windows Credential Manager and the Linux Secret Service, under service `agentlink` and one account per agent, so several agents share a machine. The agent's identity is read from the keychain for each operation, checked against the agent ID, used and wiped; a missing or mismatched item is an error with a fix and never creates a new identity. Includes creating an agent in the keychain (never overwriting), the keychain probe and the backend choice at setup: without a usable keychain the answer is `needs_setup` unless the user opted in to the passphrase-locked file, which lands later.
