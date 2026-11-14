---
'@4thtech-io/core': patch
---

P2-UNREAD-AGE and P2-TRUNCATED-COUNT: a received message whose first-seen row was pruned (never read, nothing saved) now ages out under the same keep-days rule instead of staying for ever, and the history plan counts `truncated` after the local-age filter, walking past rows that are old by their date but new on this computer.
