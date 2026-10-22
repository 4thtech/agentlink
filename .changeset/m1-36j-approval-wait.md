---
'@4thtech-io/agentlink': minor
---

While the owner's approval page is open, a tool that needs approval now waits briefly for the owner's decision inside the same call (per harness: Claude Code and Gemini CLI 45 s, Codex 30 s, any other harness no wait). An approval tells the agent to call the tool again now with the approvalId; a denial returns `rejected` with `APPROVAL_DENIED`. A timeout or a client cancel returns the usual `pending_approval` result unchanged (M1-36j).
