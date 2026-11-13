---
'@4thtech-io/types': patch
'@4thtech-io/node': patch
---

CI-823 (RET-6/7): the 06 §3 policy defaults keep history forever (`history: {messagesKeepDays: 0, filesKeepDays: 0}`), so a first edit of rules never signed never starts deleting; a new ID's first rules still keep saved files 90 days (`HISTORY_NEW_ID`). The owner-action signing vectors (version 9) carry the same defaults.
