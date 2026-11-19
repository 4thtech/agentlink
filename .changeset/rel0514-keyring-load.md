---
'@4thtech-io/node': patch
---

Fewer system keychain reads: an agent works out its public keys once per key version instead of reading its key from the keychain for every look-up. Signing still reads the key each time (REL0514-KEYRING).
