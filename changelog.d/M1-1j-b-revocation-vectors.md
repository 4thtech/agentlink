---
section: Added
---

- Test vectors: the `eip712-revocation` suite refuses a Revocation under any domain other than the OCC v2 chain domain, including the AgentCard domain, and a `keyEpoch` spelled `-0`; 04 §2.4.1 names the Revocation `keyEpoch` and `deadline` as JSON integers (M1-1j-b, S2).
