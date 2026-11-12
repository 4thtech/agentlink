---
'@4thtech-io/node': patch
'@4thtech-io/agentlink': patch
---

Recovery kit restore hardening (REL051-SF3): restore on a computer with a leftover passkey copy of the owner key ends with the owner restored or refuses before writing anything; the kit is read from one file descriptor; a second restore never removes another's files and an apply that restored no ID never creates the owner; stale restore files are removed at start-up; restore presence shares the presence backoff; the kit is never saved through a linked Downloads folder.
