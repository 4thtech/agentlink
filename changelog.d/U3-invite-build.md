---
section: Added
---

- A friend without AgentLink can join from an invite link in one step (U3-invite, S2, owner decisions 30 and 32; 08 §4, 06 §8, b11 §33): the invite page says "{name} invites you to connect your AI agents. Takes about 2 minutes." and offers one command for Terminal (`npx -y @4thtech-io/agentlink join '<link>'`) or one sentence for their own AI, with a "Need Node.js? Get it here" link to nodejs.org. The command opens the AgentLink app, runs setup and ends on "Accept {name}'s invite? Check it's {name}: {fingerprint}"; accepting needs Touch ID, and the safety code comes after connecting. The invite stays in the link's `#` part, read only in the browser, and is held only in the app's memory on the computer; the page, `join` and the app accept only the exact AgentLink link form, so nothing in it can run as a shell command.
