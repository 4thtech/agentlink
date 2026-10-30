---
'@4thtech-io/node': patch
'@4thtech-io/agentlink': patch
---

W4-ONE-TOUCH (D-140): one Touch ID creates an agent and connects its AI app. First run `begin` takes `{label, app?}` and makes the first agent's keys in memory beside the owner seed (at most 120 s, one page session); the passkey create carries a challenge bound to the statement and the plan (card, policy, label, `app.connect`); `finish` takes only `{nonce}` and the creation response, signs exactly the plan through a restricted owner session, and writes the AI app entry last, after the owner key is wiped. New agent is now `POST /api/ui/agents/begin` `{label, app?}` and `POST /api/ui/agents` `{nonce}` with one passkey `get` (or the backup code). A wrong proof keeps the plan (the third ends it); a changed config file is refused before signing; a failed entry write keeps the agent and answers `created_not_connected` (the stored `app.connect` is recorded as not applied). Core gains `ownerActions.markAppNotApplied`.
