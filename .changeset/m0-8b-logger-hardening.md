---
'@agentlink/log': patch
---

Harden the log redaction: values with escaped quotes, nested JSON or objects and arrays are redacted in full, with no length cap that would let the tail of a long secret through; backslash, JSON-escaped and protocol-relative URLs are reduced to their origin; the cost of the pair scanner is bounded.
