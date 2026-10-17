---
section: Fixed
---

- CLI (M1-22-b, S1, 06 §2.2): `agentlink_inbox` failed with an output-schema error for any message that carried terms, because the new `termsParties` field was not declared in the tool's output schema. It is declared now, and the inbox, status and contacts tests validate their results against the declared schema.
