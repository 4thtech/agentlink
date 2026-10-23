---
section: Changed
---

- The hourly deploy reconcile no longer stacks approval requests (CHORE-DEPLOY-RECONCILE-b, S2): while a production run for any commit waits for the owner's approval, it dispatches nothing and the run summary asks the owner to approve or cancel it. When it finds no production deploy in the last 30 finished runs it now raises a warning (log and summary) instead of a notice.
