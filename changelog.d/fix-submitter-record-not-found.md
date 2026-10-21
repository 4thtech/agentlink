---
section: Fixed
---

- Submitter: notarizing a new record answered 503 `unavailable`, because the Notary reports an unknown record with an error the submitter took for a chain failure. The submitter now treats that answer as "not recorded yet" and simulates the record as usual (M1-10c, S2).
