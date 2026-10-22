---
section: Changed
---

- Owner code at the wrong prompt (M1-9zd, S1, 04 §2.5, 11 §5.5): every owner command now says, right before the owner code prompt, that the code goes only there, not into a shell command or a chat, and a wrong code gets the same reminder. A command line with something shaped like an owner code in it stops before anything runs, never repeats it, and points to `agentlink owner change-code`. Troubleshooting explains what to do when the code was typed at the shell prompt or into a chat.
