---
section: Changed
---

- A new agent's local store is created in one step, and an older one is upgraded in one step that is all or nothing: a failed upgrade leaves the store as it was, never half upgraded. A new store also no longer rewrites itself once on its first open. Faster first start, most of all on Windows (STORE-CREATE-ONE-TX, S1, 07 §3.7).
