---
'@4thtech-io/node': patch
'@4thtech-io/agentlink': patch
---

`agentlink init` opens the local app's first-run page for a new owner (M1-11b-6, D-120): in your own terminal, the browser opens the setup page with a one-time link, you protect approvals with a passkey, and the settings pages work while the window stays open. Run by an AI, `init` never opens or prints the link; it tells you to run `agentlink init` yourself. The setup page is offered only while no owner exists anywhere on this computer (including a passphrase-file owner). The CLI build now always includes the local app.
