---
section: Added
---

- Hostile-peer and hostile-relay tests (E2E-HOSTILE, S1, 04 §3.4, 06 §3, 07 §3.8, §4.2): a misbehaving contact and a misbehaving relay run against a real core in CI. They check that a relay that does not serve a message back never earns a plain "Sent", that text that reads like instructions stays untrusted, that acknowledgements never delete or keep more than their own message, that offers meet the sending caps, that messages from before a restore start nothing automatically, that refused sends clean up their uploads and that parallel proof requests sign and charge once.
