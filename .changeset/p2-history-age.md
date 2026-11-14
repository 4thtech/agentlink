---
'@4thtech-io/core': patch
---

P2-TRUNCATED-COUNT: the history plan counts `truncated` after the local-age filter, walking past rows that are old by their date but new on this computer, within a bounded scan.
