---
'@4thtech-io/crypto': minor
---

The recovery kit format `ALKK` v1 (04 §2.3.3, D-115; M1-9i-b): `sealRecoveryKit` and `openRecoveryKit` in `@4thtech-io/crypto/keystore`, `readRecoveryKitHeader` and the kit constants in the main entry, with the `recovery-kit` vector suite. The STREAM body of `ALF1` is now shared with the kit (no change to `ALF1` output).
