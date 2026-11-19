---
section: Security
---

- The key store itself now guards proof signing (SEC-KEYSTORE-RECORD-GATE, S2, D-156; 04 §3.1.1, 07 §3.5). A proof record is signed only with a single-use ticket bound to exactly that record, which AgentLink asks for only in the step that sets the fee aside in your spending budget; a ticket never signs a second record or the same one twice, and no other signing path signs a proof record.
