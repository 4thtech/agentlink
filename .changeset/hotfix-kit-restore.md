---
'@4thtech-io/node': patch
---

HOTFIX-KIT-RESTORE: a recovery kit now restores for real agents. The store check after decryption (`checkQuarantinedSnapshot`, 04 §2.3.3) read the stored card's `ownerNostr` as bare hex, but cards spell it `0x` + hex (04 §2.4.1), so every real kit was refused with `open_failed`. It now decodes exactly the card spelling (`decodeHex0x`, 32 bytes) and keeps the constant-time comparison and the one generic error.
