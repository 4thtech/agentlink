---
section: Added
---

- Hostile-peer and hostile-relay tests (E2E-HOSTILE, S1, 04 §3.4, 06 §3, 07 §3.8, §4.2): a misbehaving contact and a misbehaving relay run against a real core in CI. They check that a relay that does not serve a message back never earns a plain "Sent", that text that reads like instructions stays untrusted, that acknowledgements never delete or keep more than their own message, that offers meet the sending caps, that messages from before a restore start nothing automatically, that refused sends clean up their uploads and that parallel proof requests sign and charge once.

The nine scenarios:

- A message from a relay that serves nothing back stays "not yet confirmed", never "Sent".
- Instruction-like text in a message stays untrusted and starts nothing.
- An acknowledgement with another hash, for another message or from another key epoch is not a receipt.
- An acknowledgement delivered again, or reused for another message, counts once, for its own message only.
- Acknowledgements never delete or keep more than their own message.
- Offers beyond the sending caps are refused.
- Messages from before a restore start nothing automatically.
- A refused send cleans up its uploads.
- Parallel proof requests sign and charge once.
