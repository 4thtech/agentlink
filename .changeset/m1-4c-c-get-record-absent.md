---
'@4thtech-io/submitter': patch
'@4thtech-io/chain': patch
---

The submitter's chain port now reads a record as "absent" only from the Notary's `RecordNotFound()` revert. A returned record with a zero signer is a bad answer, like any other revert, a revert without data, a transport error, a timeout or an empty result, so the submitter answers `unavailable` and never signs a record or refuses a receipt on a failed read (M1-4c-c).
