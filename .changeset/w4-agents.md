---
'@4thtech-io/node': patch
'@4thtech-io/agentlink': patch
---

W4-AGENTS: the local app's Agents section. Simple: one card per agent with its letter icon and live status ("Working in Claude Code", "Ready", "Offline · last seen 5 min ago", "Paused"), its AI apps with their words, and Pause (one click), Resume with Touch ID, Rename ("Your contacts will see the new name", the rename limit, "Update contacts"), AI apps (Connect or Disconnect with the exact change, quit first and restart), Back up and Remove (type the name). New agent opens Get started. Under the hood: the same screen as a fleet table with search, status and AI app filters, sort by activity and a bulk Remove; each agent has its own page (`/agents/<name>`) with its AI apps, a heartbeat history of this session, people, rules, activity and backup.
