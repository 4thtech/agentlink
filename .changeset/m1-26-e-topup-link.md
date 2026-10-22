---
'@4thtech-io/agentlink': minor
---

M1-26-e: the top-up link, ready but off until the pay page exists. When the shipped config marks the pay page live, `needs_credits` and `agentlink_status` (`topUpUrl`) give one link, `https://{payHost}/#v=1&a=<agent ID>&usd=<suggested amount>`, with everything in the fragment so it never reaches the pay host's server (D-113), and `agentlink credits --topup` prints it with a QR code of the agent ID and opens the browser only for a person at an interactive terminal when credits are needed. The shipped config is not live yet, so today no link, QR code or browser open is given and `needs_credits` says adding credits is not available yet. The server instructions describe agent-assisted funding: the agent never asks for a passphrase, recovery code or card details and never moves funds.
