---
'@4thtech-io/agentlink': patch
---

W6-FLOW-FIXES: the local app's Remove agent sheet reads the agents list before the Touch ID step and says "Quit {app} first" while an AI app runs the agent (the server's `in_use` lock and presence are unchanged); Home marks a contact whose agent was retired (status `revoked`) as "{name} removed this connection" and hides the resend hint and the safety code check; an agent set up in an AI app that never ran it reads "Connected · restart {app} to start" instead of "Offline". No server or protocol change.
