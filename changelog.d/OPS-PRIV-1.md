---
section: Security
---

- The proof relay, the testnet credits faucet and the encrypted drop keep no logs (OPS-PRIV-1, S2, 07 §7, D-109): every deploy now also fails if streaming log consumers or log and trace export are switched on, a test checks that the relay never logs or counts an IP, address, record ID, salt, signature or transaction hash, and the owner's runbook lists the account-level logging settings to check.
