---
'@4thtech-io/node': patch
'@4thtech-io/agentlink': patch
---

W4-RENAME-REACHES-CONTACTS (D-141): renaming an agent in the app to a name its card does not have is now a key rotation in the same Touch ID: the owner signs the agent's next card with the new name, the agent's `key-epoch` item advances (compare-and-set, owner flow only), and the existing card update tells every contact the owner's rules allow. A label equal to the card's name changes only the label. At most 3 renames that rotate per agent in 24 h (`rename_limited` with `retryAt`, refused before the gesture), and none while an earlier rotation is unfinished (`rotation_pending`). A contact's rename is stored with its former name (`GET /api/ui/contacts` carries `formerName` until `GET /api/ui/contacts/:ref/name-seen`); the safety code and "Safety code checked" stay. `GET /api/ui/agents/card-name` offers "Update contacts" for agents renamed before this change. A contact that still writes to a superseded key gets the current card again, at most once a day. No MCP tool or CLI command renames an agent. Store schema version 8 (three nullable contacts columns).
