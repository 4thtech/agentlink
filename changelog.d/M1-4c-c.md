---
section: Security
---

- Submitter: a chain read of a record counts as "not recorded" only when the Notary says the record does not exist. Any other answer that is not a stored record, such as a zeroed record, now makes the submitter answer `unavailable` rather than decide on it (M1-4c-c, S2).
