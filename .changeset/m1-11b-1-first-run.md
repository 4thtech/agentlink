---
'@4thtech-io/node': patch
'@4thtech-io/agentlink': patch
---

The local app's first-run page (M1-11b-1, D-120): protect approvals with one passkey, see your owner fingerprint and a backup owner code (collapsed), put the recovery kit off with "Later", and go back to your AI with a prompt to copy. A new read route, `GET /api/ui/first-run`, says only whether approvals are protected yet. The shared page states (link expired, AgentLink not running, setup unfinished, recovery kit reminder, network, empty, loading and error) follow the d1 design.
