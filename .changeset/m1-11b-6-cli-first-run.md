---
'@4thtech-io/node': patch
'@4thtech-io/agentlink': patch
---

`agentlink init` opens the local app's first-run page for a new owner (M1-11b-6, D-120): in your own terminal, the browser opens the setup page with a one-time link, you protect approvals with a passkey, and the settings pages work while the window stays open (at most 30 minutes). Run by an AI, `init` never opens or prints the link; it tells you to run `init` yourself, named the way AgentLink was started. The setup page is offered only while no owner exists anywhere on this computer: no owner key, no passphrase-file owner, and no other agent (including one restored from a recovery kit before its owner). The CLI build now always includes the local app.
