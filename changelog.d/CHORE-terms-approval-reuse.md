---
section: Fixed
---

- Terms approvals are refused consistently on reuse (CHORE-terms-approval-reuse, S2, 04 §3.4.2): a second call with an already used approval now always answers that the approval was used, with the accept it sent, even when the first accept is still being delivered or the calls run at the same time. Only one accept was ever sent; the answer to the extra call is what changed.
