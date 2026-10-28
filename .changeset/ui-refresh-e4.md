---
'@4thtech-io/ui': patch
---

UI-REFRESH-e4: hardening of the Under the hood allowlist. Ids made of several parts are judged by their combined length, the split-value check handles shorter pieces and more separators, the sensitive-label list also covers salt, private, recovery and mnemonic wording, and look-alike spellings of the labels are treated like the plain ones.
