---
'@4thtech-io/agentlink': minor
---

M1-26-e: the top-up link. When proof needs credits, `agentlink_status` (`topUpUrl`) and the `needs_credits` result give one link, `https://{payHost}/#v=1&a=<agent ID>&usd=<suggested amount>`, with everything in the fragment so it never reaches the pay host's server (D-113). The `nextStep` says in dollars what to add and what $5 covers. `agentlink credits --topup` prints the link, a QR code of the agent ID, and opens the browser when run in a terminal. The server instructions and the skill file tell the agent to explain the one step, share the link, watch `credits` and confirm; it never asks for a passphrase, recovery code or card details and never moves funds.
