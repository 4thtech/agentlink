---
'@4thtech-io/agentlink': patch
'@agentlink/core': patch
---

`agentlink_accept_invite` now spells out its two steps: after the owner approves, call it again with the same invite link and the `approvalId`. Calling it again without the `approvalId` returns the request it already made instead of asking the owner a second time; once the owner has approved, it runs nothing and names the `approvalId` to use. Core adds `ApprovalService.findOpen`.
