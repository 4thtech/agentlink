# @4thtech-io/log

## 0.1.1

No changes in this release.

## 0.1.0

### Patch Changes

- 1377cb5: Harden the log redaction: values with escaped quotes, nested JSON or objects and arrays are redacted in full, with no length cap that would let the tail of a long secret through; backslash, JSON-escaped and protocol-relative URLs are reduced to their origin; the cost of the pair scanner is bounded.
