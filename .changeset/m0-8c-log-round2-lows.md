---
'@4thtech-io/log': patch
---

M0-8c: the redacting logger no longer over-redacts after an apostrophe in a bracketed value, reduces a JSON-escaped protocol-relative URL to its host, and redacts `upload` URL fields whole.
