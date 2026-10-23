---
section: Fixed
---

- Storage no longer leaves a half-finished upload behind when the storage service's answer is lost, reports a failing file stream as a plain storage error, and applies the 30-day cleanup rule only after checking that the bucket's other rules were not changed in between (M1-6b-b, S1, 07 §5.2). Reading the rule back on Cloudflare R2 still waits for the owner step M1-28.
