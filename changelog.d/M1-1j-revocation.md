---
section: Added
---

- Revocation signing data (M1-1j, S2, 05 §4, D-81): the crypto package builds and hashes the EIP-712 `Revocation` an owner signs to revoke an agent, under the OCC v2 chain domain with the Registry as verifying contract, and refuses every non-canonical form. The `eip712-revocation` test vectors now run in every runtime.
