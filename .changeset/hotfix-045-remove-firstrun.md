---
'@4thtech-io/node': patch
'@4thtech-io/agentlink': patch
---

HOTFIX-045-REMOVE-FIRSTRUN: Remove works in the app session that first run started. The no-agent app host (`startUiWelcome`) now gets the same removal port (`uiRemovalPort`) as the host `agentlink ui` starts for an existing agent, so `POST /api/ui/agents/remove` no longer answers 501 there until the app is restarted. Same route, same gates (session, Host, Origin, CSRF, fetch metadata, generation, owner presence, signed `agent.revoke`).
