---
section: Security
---

- Mac in-app update groundwork (UPD-4, S2, 04 §7): the app can download its signed update package, check it and swap it in through a small helper that puts the previous version back if the new one does not start; not switched on yet. A new threat-model row records the remaining check-then-swap gap until the app is Developer ID signed.
