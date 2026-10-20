---
'@4thtech-io/core': patch
---

Proofs (M1-33c, D-109): a Record's `parentRecordId` is zero by default and only ever names a record the chain shows this agent signed; anything else is refused with `PARENT_NOT_OWN` and nothing is signed or charged. A received Record that names another signer's record as its parent is dropped and logged (`proof_parent_mismatch`) and gets no receipt; flagging the contact is pending M1-7g-c.
