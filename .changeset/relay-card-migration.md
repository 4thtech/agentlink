---
'@4thtech-io/core': patch
'@4thtech-io/agentlink': patch
---

RELAY-CARD-MIGRATION: an ID whose card still lists a server the default set dropped can move to the current set with one owner approval ("Update your contact details" on Home, or `agentlink owner update-contact-details`). It issues the next card with the updated list; contacts get it through the usual card update, which during the transition is also sent to the old servers. No AI tool can start or approve it. If the owner never does it, nothing breaks: the old servers are still read. `agentlink doctor` mentions it when it applies.
