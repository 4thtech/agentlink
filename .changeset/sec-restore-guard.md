---
'@4thtech-io/core': patch
'@4thtech-io/node': patch
'@4thtech-io/agentlink': patch
---

SEC-RESTORE-GUARD (D-156): after an ID is restored from a backup, every paid action asks the owner for 24 hours (the hard spending limits still refuse), the sending limits are halved for those 24 hours, and the rules alone never accept terms. Messages that were sent before the restore and arrive again are stored and shown but trigger nothing automatically: no received receipt, no automatic file save or on-chain receipt, no file link answered, and a contact they connect waits for the owner. The restore time is kept with the ID's keys; if it cannot be read, AgentLink acts as if the ID was just restored.
