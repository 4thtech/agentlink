---
'@agentlink/types': patch
---

The pinned UCD 15.0.0 character table behind the `terms` character rule (`refusedCategory15`) is now generated from the vendored, SHA-256-pinned UCD file `DerivedGeneralCategory.txt` instead of the interpreter's Unicode data (D-74, D-77). Its content is unchanged: no code point is categorised differently. Only the generated file's provenance comment changes.
