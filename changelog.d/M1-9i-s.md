---
section: Changed
---

- Spec for own storage and the recovery kit (M1-9i-s, S2, D-115; 04 §2.2, §2.3.3, §2.5, §2.5.1, §2.8; 06 §8; 07 §3, §3.4, §5.2, §5.6, §9.1, §9.4): new owner operations `storage.set`, `storage.remove` and `backup.export`; the CLI recovery kit format `ALKK` v1, sealed under a fresh recovery code for every export; restore never overwrites and keeps an existing owner only after its own owner code opens it; storage access keys stay out of the kit and are reconnected after a restore; new `agentlink storage disconnect` command. Spec text only; the build follows in M1-9i-a, M1-9i-b, M1-9i-c and M1-9i.
