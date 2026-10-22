---
'@4thtech-io/core': patch
---

Accepting an invite now also checks that the contact being staged has the owner shown for approval and is exactly the card the invite carried (its owner fingerprint and its card hash). A card with the right contact id but another owner, keys or epoch is refused as an invalid invite before anything is written.
