---
'@4thtech-io/node': patch
'@4thtech-io/agentlink': patch
---

W4-SHELL-V2: the local app's new shell. One top bar: the agent chip with a live dropdown (each agent and each AI app with a plain status, other AI apps with Connect, Add agent, Manage agents), Go to (Cmd+K), a "?" Help menu (Get started, Keyboard shortcuts, User guide, Report a problem) and the Under the hood switch. A minimized section menu (Home, Agents, Activity, Settings; Advanced while Under the hood is on; a sheet on a phone). Under the hood shows a live status strip, is kept by the app for every window (`GET/PUT /api/ui/ui-settings`) and has the shortcut Cmd+Shift+U. Old addresses keep working.
