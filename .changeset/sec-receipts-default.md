---
'@4thtech-io/types': patch
'@4thtech-io/chain': patch
'@4thtech-io/core': patch
'@4thtech-io/mcp-tools': patch
'@4thtech-io/node': patch
'@4thtech-io/agentlink': patch
---

SEC-RECEIPTS-DEFAULT (D-156): the signed "received" receipt to active contacts is on by default, under the owner's rule `receipts.sendReceived` (absent reads as on), shown on the Rules page as "Tell contacts when your AI receives a message", with a one-time notice on Home for people who upgraded and a one-time line in `agentlink_status`. Each receipt is published after a random 5–90 s and signs its time rounded down to the minute. The receipt body names the message's content hash as well as its ID; the sender shows "Received by <name>'s app" only for that kind, "Received (older app)" for an older app's receipt, and never shows a message sent with proof as delivered without it. Only keys from the contact's card history count. On request (`includeDeviceReceipt`, off by default), a sender's proof pack carries the contact's receipt in `deviceReceipts` (with the contact's card) together with the recipient opening; the verifier accepts it only when that opening names the card's agent, and reports it as "automatic device receipt" apart from public receipts. Proof packs made with 0.5.10 need 0.5.10 or later to verify; 0.5.10 verifies packs from both versions.
