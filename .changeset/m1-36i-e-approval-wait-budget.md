---
'@4thtech-io/agentlink': patch
---

One time budget per tool call (M1-36i-e): the time a tool already spent in the call, such as waiting up to 20 seconds for free test credits, now comes off the wait for the owner's approval decision instead of adding to it. The call never waits longer than the harness's approval wait (Codex 30 s, Claude Code and Gemini CLI 45 s); when that time is used up, the approval link comes back at once. Approvals and proof fees are unchanged.
