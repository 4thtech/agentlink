---
'@4thtech-io/agentlink': patch
---

`agentlink mcp` opens the AgentLink setup page in your browser once each time your AI app starts it, while this computer has no owner yet (M1-11b-8, 06 §7). Nothing opens when an owner exists, in CI, over SSH or without a display, and your AI never sees the page's one-time link. `init` re-run with nothing to change now offers the setup page only when no other agent is on this computer.
